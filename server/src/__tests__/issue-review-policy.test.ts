import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb, issues, type Db } from "@paperclipai/db";
import { HttpError } from "../errors.js";
import {
  assertAgentCompletionGoesThroughReview,
  assertIssueReviewVerdictActorAllowed,
  isIssueReviewVerdictInteraction,
} from "../services/issue-review-policy.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("issue review verdict policy", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-review-policy-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedReview(policy: "not_creator" | "human_only") {
    const companyId = randomUUID();
    const requesterAgentId = randomUUID();
    const peerAgentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Review Policy Company",
      issuePrefix: "RPC",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: requesterAgentId,
        companyId,
        name: "Requester",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: peerAgentId,
        companyId,
        name: "Peer reviewer",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    const [issue] = await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Review this",
      status: "in_review",
      priority: "medium",
      reviewPolicy: policy,
      createdByAgentId: requesterAgentId,
    }).returning();
    return { issue, companyId, requesterAgentId, peerAgentId };
  }

  it("does no database work for the default anyone policy", async () => {
    const noQueryDb = new Proxy({}, {
      get() {
        throw new Error("default policy must not query");
      },
    }) as Db;

    await expect(assertIssueReviewVerdictActorAllowed(noQueryDb, {
      issue: { id: randomUUID(), companyId: randomUUID(), reviewPolicy: null },
      actor: { type: "agent", id: randomUUID() },
    })).resolves.toBeUndefined();
  });

  async function logStatus(
    seeded: Awaited<ReturnType<typeof seedReview>>,
    actor: { type: "agent" | "user" | "system"; id: string },
    details: Record<string, unknown>,
    at: Date,
  ) {
    await db.insert(activityLog).values({
      companyId: seeded.companyId,
      actorType: actor.type,
      actorId: actor.id,
      agentId: actor.type === "agent" ? actor.id : null,
      action: "issue.updated",
      entityType: "issue",
      entityId: seeded.issue.id,
      details,
      createdAt: at,
    });
  }
  const move = (from: string, to: string) => ({ status: to, changes: { status: { from, to } } });
  function completeAsAgent(seeded: Awaited<ReturnType<typeof seedReview>>, agentId: string) {
    return assertAgentCompletionGoesThroughReview(db, {
      issue: { ...seeded.issue, status: "in_progress" },
      actor: { type: "agent", id: agentId },
      nextStatus: "done",
    });
  }

  it("keeps the review cycle open across a preserved in_review decision", async () => {
    const seeded = await seedReview("not_creator");
    await logStatus(seeded, { type: "agent", id: seeded.requesterAgentId }, move("in_progress", "in_review"), new Date(1_000));
    await logStatus(seeded, { type: "system", id: "native" }, { fromStatus: "in_review", toStatus: "in_review" }, new Date(2_000));
    await logStatus(seeded, { type: "agent", id: seeded.peerAgentId }, move("in_review", "in_progress"), new Date(3_000));

    await expect(completeAsAgent(seeded, seeded.peerAgentId)).resolves.toBeUndefined();
  });

  it("blocks completion after a reviewer rejected the work back to todo", async () => {
    const seeded = await seedReview("not_creator");
    await logStatus(seeded, { type: "agent", id: seeded.requesterAgentId }, move("in_progress", "in_review"), new Date(1_000));
    await logStatus(seeded, { type: "agent", id: seeded.peerAgentId }, move("in_review", "todo"), new Date(2_000));
    await logStatus(seeded, { type: "agent", id: seeded.requesterAgentId }, move("todo", "in_progress"), new Date(3_000));

    await expect(completeAsAgent(seeded, seeded.peerAgentId)).rejects.toMatchObject({ status: 403 });
  });

  it("blocks completion when a later reopen closed the review cycle", async () => {
    const seeded = await seedReview("not_creator");
    await logStatus(seeded, { type: "agent", id: seeded.peerAgentId }, move("in_progress", "in_review"), new Date(1_000));
    await logStatus(seeded, { type: "user", id: "board" }, move("done", "todo"), new Date(2_000));
    await logStatus(seeded, { type: "agent", id: seeded.requesterAgentId }, move("todo", "in_progress"), new Date(3_000));

    await expect(completeAsAgent(seeded, seeded.requesterAgentId)).rejects.toMatchObject({ status: 403 });
  });

  it("blocks completion when no agent requested the open review", async () => {
    const seeded = await seedReview("not_creator");
    await logStatus(seeded, { type: "user", id: "board" }, move("in_progress", "in_review"), new Date(1_000));
    await expect(completeAsAgent(seeded, seeded.requesterAgentId)).rejects.toMatchObject({ status: 403 });
  });

  it("blocks completion when only the native system moved the issue to in_review", async () => {
    const native = await seedReview("not_creator");
    await logStatus(native, { type: "system", id: "native" }, { fromStatus: "in_progress", toStatus: "in_review" }, new Date(1_000));
    await expect(completeAsAgent(native, native.peerAgentId)).rejects.toMatchObject({ status: 403 });
  });

  it("lets only a non-requester agent complete a not_creator issue outside in_review", async () => {
    const seeded = await seedReview("not_creator");
    await db.insert(activityLog).values({
      companyId: seeded.companyId,
      actorType: "agent",
      actorId: seeded.requesterAgentId,
      agentId: seeded.requesterAgentId,
      action: "issue.updated",
      entityType: "issue",
      entityId: seeded.issue.id,
      details: { status: "in_review", _previous: { status: "in_progress" } },
    });
    // The reviewer's checkout moved the issue back to in_progress.
    const issue = { ...seeded.issue, status: "in_progress" };

    await expect(assertAgentCompletionGoesThroughReview(db, {
      issue,
      actor: { type: "agent", id: seeded.peerAgentId },
      nextStatus: "done",
    })).resolves.toBeUndefined();
    await expect(assertAgentCompletionGoesThroughReview(db, {
      issue,
      actor: { type: "agent", id: seeded.requesterAgentId },
      nextStatus: "done",
    })).rejects.toMatchObject<HttpError>({ status: 403 });
  });

  it("blocks direct agent completion when no review was ever requested", async () => {
    const seeded = await seedReview("not_creator");
    await expect(assertAgentCompletionGoesThroughReview(db, {
      issue: { ...seeded.issue, status: "in_progress" },
      actor: { type: "agent", id: seeded.peerAgentId },
      nextStatus: "done",
    })).rejects.toMatchObject<HttpError>({ status: 403 });
  });

  it("blocks the in-review requester under not_creator and admits another agent", async () => {
    const seeded = await seedReview("not_creator");
    expect(seeded.issue.reviewPolicy).toBe("not_creator");
    await db.insert(activityLog).values({
      companyId: seeded.companyId,
      actorType: "agent",
      actorId: seeded.requesterAgentId,
      agentId: seeded.requesterAgentId,
      action: "issue.updated",
      entityType: "issue",
      entityId: seeded.issue.id,
      details: { status: "in_review", _previous: { status: "in_progress" } },
    });

    const denied = assertIssueReviewVerdictActorAllowed(db, {
      issue: seeded.issue,
      actor: { type: "agent", id: seeded.requesterAgentId },
    });
    await expect(denied).rejects.toMatchObject<HttpError>({
      status: 403,
      details: expect.objectContaining({
        code: "review_policy_denied",
        policy: "not_creator",
        allowedActor: "writer_other_than_review_requester",
      }),
    });
    await expect(assertIssueReviewVerdictActorAllowed(db, {
      issue: seeded.issue,
      actor: { type: "agent", id: seeded.peerAgentId },
    })).resolves.toBeUndefined();
  });

  it("ignores later in-review snapshots that did not record a status transition", async () => {
    const seeded = await seedReview("not_creator");
    await db.insert(activityLog).values([
      {
        companyId: seeded.companyId,
        actorType: "agent",
        actorId: seeded.requesterAgentId,
        agentId: seeded.requesterAgentId,
        action: "issue.updated",
        entityType: "issue",
        entityId: seeded.issue.id,
        details: { status: "in_review", _previous: { status: "in_progress" } },
        createdAt: new Date("2026-08-06T00:00:00.000Z"),
      },
      {
        companyId: seeded.companyId,
        actorType: "agent",
        actorId: seeded.peerAgentId,
        agentId: seeded.peerAgentId,
        action: "issue.updated",
        entityType: "issue",
        entityId: seeded.issue.id,
        details: { status: "in_review", priority: "high" },
        createdAt: new Date("2026-08-06T00:01:00.000Z"),
      },
    ]);

    await expect(assertIssueReviewVerdictActorAllowed(db, {
      issue: seeded.issue,
      actor: { type: "agent", id: seeded.requesterAgentId },
    })).rejects.toMatchObject<HttpError>({
      status: 403,
      details: expect.objectContaining({ code: "review_policy_denied" }),
    });
    await expect(assertIssueReviewVerdictActorAllowed(db, {
      issue: seeded.issue,
      actor: { type: "agent", id: seeded.peerAgentId },
    })).resolves.toBeUndefined();
  });

  it("classifies only confirmations created by the review requester as review verdicts", async () => {
    const seeded = await seedReview("not_creator");
    await db.insert(activityLog).values({
      companyId: seeded.companyId,
      actorType: "agent",
      actorId: seeded.requesterAgentId,
      agentId: seeded.requesterAgentId,
      action: "issue.updated",
      entityType: "issue",
      entityId: seeded.issue.id,
      details: {
        status: "in_review",
        reviewInteractionId: "review-confirmation",
        _previous: { status: "in_progress" },
      },
    });

    await expect(isIssueReviewVerdictInteraction(db, {
      issue: seeded.issue,
      interaction: { id: "review-confirmation", createdByAgentId: seeded.requesterAgentId },
    })).resolves.toBe(true);
    await expect(isIssueReviewVerdictInteraction(db, {
      issue: seeded.issue,
      interaction: { id: "review-confirmation", createdByAgentId: seeded.peerAgentId },
    })).resolves.toBe(false);
    await expect(isIssueReviewVerdictInteraction(db, {
      issue: seeded.issue,
      interaction: { id: "requester-sibling", createdByAgentId: seeded.requesterAgentId },
    })).resolves.toBe(false);
  });

  it("classifies an unbound legacy confirmation only when the review requester created it", async () => {
    const seeded = await seedReview("not_creator");
    await db.insert(activityLog).values({
      companyId: seeded.companyId,
      actorType: "agent",
      actorId: seeded.requesterAgentId,
      agentId: seeded.requesterAgentId,
      action: "issue.updated",
      entityType: "issue",
      entityId: seeded.issue.id,
      details: { status: "in_review", _previous: { status: "in_progress" } },
    });

    await expect(isIssueReviewVerdictInteraction(db, {
      issue: seeded.issue,
      interaction: { id: "legacy-review", createdByAgentId: seeded.requesterAgentId },
    })).resolves.toBe(true);
    await expect(isIssueReviewVerdictInteraction(db, {
      issue: seeded.issue,
      interaction: { id: "unrelated-confirmation", createdByAgentId: seeded.peerAgentId },
    })).resolves.toBe(false);
  });

  it("uses authenticated principal type for human_only", async () => {
    const seeded = await seedReview("human_only");
    expect(seeded.issue.reviewPolicy).toBe("human_only");
    const denied = assertIssueReviewVerdictActorAllowed(db, {
      issue: seeded.issue,
      actor: { type: "agent", id: seeded.requesterAgentId },
    });
    await expect(denied).rejects.toMatchObject<HttpError>({
      status: 403,
      details: expect.objectContaining({
        code: "review_policy_denied",
        policy: "human_only",
        allowedActor: "authenticated_user_with_issue_write_access",
      }),
    });
    await expect(assertIssueReviewVerdictActorAllowed(db, {
      issue: seeded.issue,
      actor: { type: "user", id: "board-user" },
    })).resolves.toBeUndefined();
  });
});
