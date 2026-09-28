// Compatibility cleanup for stop-only intents persisted by the former manual repair flow.
// New unsafe exports complete automatically and never create these intents.
import { and, eq, sql } from "drizzle-orm";
import { environmentLeases, type Db } from "@paperclipai/db";
import { remoteTerminationReceipt } from "../remote-execution-termination.js";

type Lease = {
  id: string; companyId: string; heartbeatRunId: string | null;
  provider: string | null; providerLeaseId: string | null;
  metadata: Record<string, unknown> | null;
};

export const NATIVE_WORKSPACE_EXPORT_RESUME_KEY = "nativeWorkspaceExportResume";

export function hasNativeWorkspaceExportResume(lease: Pick<Lease, "metadata">): boolean {
  return Object.prototype.hasOwnProperty.call(lease.metadata ?? {}, NATIVE_WORKSPACE_EXPORT_RESUME_KEY);
}

/** This intent is written before resuming a retained sandbox. Recovery may stop
 * this exact allocation, but must never fall through to destructive cleanup. */
export function readNativeWorkspaceExportResume(lease: Lease) {
  const value = lease.metadata?.[NATIVE_WORKSPACE_EXPORT_RESUME_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const marker = value as Record<string, unknown>;
  if (!["paperclip.workspace-export-resume.v1", "paperclip.workspace-export-resume.v2"].includes(String(marker.schema))
    || marker.companyId !== lease.companyId || marker.runId !== lease.heartbeatRunId || !lease.heartbeatRunId
    || marker.leaseId !== lease.id || marker.provider !== lease.provider || !lease.provider
    || marker.providerLeaseId !== lease.providerLeaseId || !lease.providerLeaseId
    || typeof marker.requestId !== "string" || !marker.requestId
    || typeof marker.resultId !== "string" || !marker.resultId) return null;
  // v1 preceded the intent's explicit plugin pin. Its exact lease already
  // recorded the acquiring plugin; never reconstruct that owner from a driver
  // name, and never override an explicit (even invalid) intent pin.
  const pluginId = marker.schema === "paperclip.workspace-export-resume.v1" && marker.pluginId === undefined
    ? lease.metadata?.pluginId : marker.pluginId;
  if (typeof pluginId !== "string" || !pluginId || pluginId !== lease.metadata?.pluginId) return null;
  return { ...marker, requestId: marker.requestId, resultId: marker.resultId, pluginId };
}

/** A late cleanup receipt cannot rewrite a rebound lease or a newer attempt. */
export async function settleNativeWorkspaceExportResume(db: Db, lease: Lease, options: {
  attemptId: string; receipt?: unknown; status?: "released" | "expired";
}) {
  const marker = readNativeWorkspaceExportResume(lease);
  if (!marker) return null;
  const receipt = remoteTerminationReceipt(lease, options.receipt);
  const stopped = receipt?.state === "stopped";
  const now = new Date();
  const [row] = await db.update(environmentLeases).set({
    status: stopped ? options.status ?? "released" : "pending_cleanup", cleanupStatus: stopped ? "success" : "failed",
    releasedAt: now, lastUsedAt: now, updatedAt: now,
    metadata: sql`(${environmentLeases.metadata} - 'remoteExecutionTermination'
      ${stopped ? sql`- 'nativeWorkspaceExportResume'` : sql``}) || ${JSON.stringify({
        ...(stopped ? { remoteExecutionTermination: receipt } : {}),
        pendingCleanupInFlight: false, pendingCleanupLeaseExpiresAtMs: 0,
      })}::jsonb`,
  }).where(and(eq(environmentLeases.id, lease.id), eq(environmentLeases.companyId, lease.companyId),
    eq(environmentLeases.heartbeatRunId, lease.heartbeatRunId!), eq(environmentLeases.provider, lease.provider!),
    eq(environmentLeases.providerLeaseId, lease.providerLeaseId!), eq(environmentLeases.status, "pending_cleanup"),
    sql`${environmentLeases.metadata}->>'pendingCleanupAttemptId' = ${options.attemptId}`,
    sql`${environmentLeases.metadata}->'nativeWorkspaceExportResume'->>'requestId' = ${marker.requestId}`,
    sql`${environmentLeases.metadata}->>'pluginId' = ${marker.pluginId}`,
  )).returning();
  return row ?? null;
}
