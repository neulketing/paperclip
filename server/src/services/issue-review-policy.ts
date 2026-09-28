import { and, desc, eq, sql } from "drizzle-orm";
import { activityLog, type Db } from "@paperclipai/db";
import type { IssueReviewPolicy } from "@paperclipai/shared";
import { forbidden } from "../errors.js";

export interface IssueReviewVerdictActor {
  type: "agent" | "user";
  id: string;
}

export interface IssueReviewRequester extends IssueReviewVerdictActor {
  reviewInteractionId: string | null;
}

interface ReviewPolicyIssue {
  id: string;
  companyId: string;
  reviewPolicy?: IssueReviewPolicy | null;
  createdByAgentId?: string | null;
  createdByUserId?: string | null;
}

export async function resolveIssueReviewRequester(
  db: Db,
  issue: ReviewPolicyIssue,
): Promise<IssueReviewRequester | null> {
  const transition = await db
    .select({
      actorType: activityLog.actorType,
      actorId: activityLog.actorId,
      details: activityLog.details,
    })
    .from(activityLog)
    .where(and(
      eq(activityLog.companyId, issue.companyId),
      eq(activityLog.entityType, "issue"),
      eq(activityLog.entityId, issue.id),
      eq(activityLog.action, "issue.updated"),
      sql`(
        (
          ${activityLog.details} ->> 'status' = 'in_review'
          AND ${activityLog.details} -> '_previous' ->> 'status' IS NOT NULL
          AND ${activityLog.details} -> '_previous' ->> 'status' <> 'in_review'
        )
        OR
        (
          ${activityLog.details} -> 'changes' -> 'status' ->> 'to' = 'in_review'
          AND ${activityLog.details} -> 'changes' -> 'status' ->> 'from' IS NOT NULL
          AND ${activityLog.details} -> 'changes' -> 'status' ->> 'from' <> 'in_review'
        )
      )`,
    ))
    .orderBy(desc(activityLog.createdAt), desc(activityLog.id))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (transition?.actorType === "agent" || transition?.actorType === "user") {
    const reviewInteractionId = typeof transition.details?.reviewInteractionId === "string"
      ? transition.details.reviewInteractionId
      : null;
    return { type: transition.actorType, id: transition.actorId, reviewInteractionId };
  }
  if (issue.createdByAgentId && !issue.createdByUserId) {
    return { type: "agent", id: issue.createdByAgentId, reviewInteractionId: null };
  }
  if (issue.createdByUserId && !issue.createdByAgentId) {
    return { type: "user", id: issue.createdByUserId, reviewInteractionId: null };
  }
  return null;
}

export async function isIssueReviewVerdictInteraction(
  db: Db,
  input: {
    issue: ReviewPolicyIssue;
    interaction: {
      id: string;
      createdByAgentId?: string | null;
      createdByUserId?: string | null;
    };
  },
): Promise<boolean> {
  const requester = await resolveIssueReviewRequester(db, input.issue);
  if (!requester) return false;
  if (requester.reviewInteractionId && requester.reviewInteractionId !== input.interaction.id) return false;
  // Older review transitions did not persist the interaction binding. In that
  // case, an unattributed confirmation is ambiguous and must fail closed.
  // Confirmations attributed to an unrelated writer remain independently
  // resolvable, while requester-created confirmations inherit the issue policy.
  if (!requester.reviewInteractionId
    && !input.interaction.createdByAgentId
    && !input.interaction.createdByUserId) {
    return true;
  }
  return requester.type === "agent"
    ? input.interaction.createdByAgentId === requester.id
    : input.interaction.createdByUserId === requester.id;
}

export async function assertIssueReviewVerdictActorAllowed(
  db: Db,
  input: {
    issue: ReviewPolicyIssue;
    actor: IssueReviewVerdictActor;
    reviewPolicy?: IssueReviewPolicy | null;
  },
): Promise<void> {
  const policy = input.reviewPolicy ?? input.issue.reviewPolicy ?? "anyone";
  if (policy === "anyone") return;

  if (policy === "human_only") {
    if (input.actor.type === "user") return;
    throw forbidden(
      "Review policy `human_only` allows only an authenticated user to approve or reject this review.",
      {
        code: "review_policy_denied",
        policy,
        allowedActor: "authenticated_user_with_issue_write_access",
        remediation: "Have an authenticated user with issue write access submit the verdict.",
      },
    );
  }

  const requester = await resolveIssueReviewRequester(db, input.issue);
  if (!requester) {
    throw forbidden(
      "Review policy `not_creator` requires a different writer, but the review requester could not be determined.",
      {
        code: "review_policy_denied",
        policy,
        allowedActor: "writer_other_than_review_requester",
        remediation: "Move the issue out of and back into `in_review` to record a requester before another writer submits the verdict.",
      },
    );
  }
  if (requester.type !== input.actor.type || requester.id !== input.actor.id) return;

  throw forbidden(
    "Review policy `not_creator` requires someone other than the writer who moved the issue into `in_review` to approve or reject it.",
    {
      code: "review_policy_denied",
      policy,
      allowedActor: "writer_other_than_review_requester",
      remediation: "Have another writer with issue write access submit the verdict.",
    },
  );
}

/**
 * A review policy only means something if work reaches `done` through a
 * review. Without this guard an agent can PATCH in_progress -> done and skip
 * the verdict check entirely, because that check only fires on
 * in_review -> done. A reviewer agent's own checkout moves the issue back to
 * in_progress, so under `not_creator` an agent other than the open review
 * requester may still complete it.
 */
export async function assertAgentCompletionGoesThroughReview(
  db: Db,
  input: {
    issue: ReviewPolicyIssue & { status: string };
    actor: IssueReviewVerdictActor;
    nextStatus: unknown;
  },
): Promise<void> {
  const policy = input.issue.reviewPolicy ?? "anyone";
  if (policy === "anyone") return;
  if (input.actor.type !== "agent") return;
  if (input.nextStatus !== "done" && input.nextStatus !== "cancelled") return;
  if (input.issue.status === "in_review" || input.issue.status === input.nextStatus) return;
  if (policy === "not_creator") {
    const requesterAgentId = await resolveOpenReviewRequesterAgent(db, input.issue);
    if (requesterAgentId && requesterAgentId !== input.actor.id) return;
  }
  throw forbidden(
    `Review policy \`${policy}\` requires moving the issue to \`in_review\` before it can be closed.`,
    {
      code: "review_policy_denied",
      policy,
      allowedActor: "reviewer_after_in_review",
      remediation: "Set the issue status to `in_review` with your report; a reviewer will close it.",
    },
  );
}

/**
 * The agent whose `in_review` request is still the open review cycle. A
 * reviewer's checkout moves the issue from `in_review` to `in_progress`, so
 * those moves are skipped; any other later status change (reopen, board move,
 * return to todo) closes the cycle and yields null. A board-made or
 * system-made `in_review` yields null too, because no agent asked for review.
 */
export async function resolveOpenReviewRequesterAgent(
  db: Db,
  issue: { id: string; companyId: string },
): Promise<string | null> {
  const targetStatus = sql<string | null>`coalesce(
    ${activityLog.details} -> 'changes' -> 'status' ->> 'to',
    ${activityLog.details} ->> 'toStatus',
    case when ${activityLog.details} -> '_previous' ->> 'status' is not null
      then ${activityLog.details} ->> 'status' end
  )`;
  // Only real transitions count; a preserved status is re-logged with from = to.
  const fromStatus = sql<string | null>`coalesce(
    ${activityLog.details} -> 'changes' -> 'status' ->> 'from',
    ${activityLog.details} ->> 'fromStatus',
    ${activityLog.details} -> '_previous' ->> 'status'
  )`;
  const latest = await db
    .select({ actorType: activityLog.actorType, actorId: activityLog.actorId, target: targetStatus })
    .from(activityLog)
    .where(and(
      eq(activityLog.companyId, issue.companyId),
      eq(activityLog.entityType, "issue"),
      eq(activityLog.entityId, issue.id),
      sql`${targetStatus} is not null and ${targetStatus} <> 'in_progress'`,
      sql`${targetStatus} is distinct from ${fromStatus}`,
    ))
    .orderBy(desc(activityLog.createdAt), desc(activityLog.id))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  return latest?.target === "in_review" && latest.actorType === "agent" ? latest.actorId : null;
}
