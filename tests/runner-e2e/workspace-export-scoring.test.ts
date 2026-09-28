import { describe, expect, it } from "vitest";
import { gradeRepairedWorkspaceExport, gradeWorkspaceExport, hasPermanentWorkspaceFailure, unsafeWorkspaceFailureCode, type WorkspaceExportObservation } from "./workspace-export-scoring.js";
import { runnerMatrix, unsafeWorkspaceExportTask } from "./catalog.js";
import { parseRunnerSelectors, selectRunnerExecutions } from "./selectors.js";
function valid(): WorkspaceExportObservation {
  const runId = "run-1";
  const marker = "EXPORT-PRESERVED-nonce";
  return {
    marker, hostLinkAbsent: true,
    issue: { status: "blocked", scheduledRetry: null, executionRunId: null, checkoutRunId: null },
    runs: [{ id: runId, runtimeMode: "native", runnerInstanceId: "runner-1", status: "failed", nativePhase: "terminal_failure",
      resultJson: { prpRunTerminalState: "succeeded", failureCode: unsafeWorkspaceFailureCode, nextAttemptAt: null } }],
    events: [
      { eventType: "run.result.accepted", payload: { prpEvent: { runId, eventType: "run.result.accepted", sourceKind: "control_plane", payload: { result: { summary: marker, reportedWorkDisposition: "done" } } } } },
      { eventType: "run.terminal", payload: { prpEvent: { runId, eventType: "run.terminal", sourceKind: "control_plane", payload: { runTerminalState: "succeeded" } } } },
      { eventType: "lifecycle", message: "native result is durable; workspace copy-back requires repair of an unsafe link or path in the retained sandbox", payload: { retryReasonCode: "workspace_sync_out_unsafe_archive", nextAttemptAt: null } },
    ],
    recovery: { active: { cause: unsafeWorkspaceFailureCode, ownerType: "board", wakePolicy: null,
      evidence: { runId, workspaceFinalizeAttempt: 1 },
      nextAction: "Repair the unsafe link or path in the retained sandbox, then retry workspace export without submitting another provider turn." } },
    leases: [{ id: "lease-1", heartbeatRunId: runId, providerLeaseId: "sandbox-1", leasePolicy: "reuse_by_environment", status: "released", cleanupStatus: "success",
      metadata: { remoteExecutionTermination: { schema: "paperclip.remote-termination.v1", state: "stopped", runId, leaseId: "lease-1", providerLeaseId: "sandbox-1" } } }],
  };
}
describe("unsafe workspace export oracle", () => {
  it("accepts retained work with immediate permanent repair ownership", () => {
    expect(gradeWorkspaceExport(valid()).every(check => check.passed)).toBe(true);
    expect(hasPermanentWorkspaceFailure(valid().runs[0])).toBe(true);
  });
  it.each([
    ["retryable original defect", (s: WorkspaceExportObservation) => { s.runs[0]!.nativePhase = "retryable_failure"; s.runs[0]!.resultJson.nextAttemptAt = "later"; }],
    ["exhausted three retries", (s: WorkspaceExportObservation) => { s.recovery.active.evidence.workspaceFinalizeAttempt = 3; }],
    ["lost accepted result", (s: WorkspaceExportObservation) => { s.events.shift(); }],
    ["foreign accepted result", (s: WorkspaceExportObservation) => { s.events[0]!.payload.prpEvent.runId = "another-run"; }],
    ["duplicate accepted result", (s: WorkspaceExportObservation) => { s.events.push(s.events[0]!); }],
    ["provider failed", (s: WorkspaceExportObservation) => { s.runs[0]!.resultJson.prpRunTerminalState = "failed"; }],
    ["sandbox destroyed", (s: WorkspaceExportObservation) => { s.leases[0]!.metadata.remoteExecutionTermination.state = "destroyed"; }],
    ["sandbox stop not proven", (s: WorkspaceExportObservation) => { s.leases[0]!.metadata = {}; }],
    ["foreign stop receipt", (s: WorkspaceExportObservation) => { s.leases[0]!.metadata.remoteExecutionTermination.providerLeaseId = "other"; }],
    ["agent replay scheduled", (s: WorkspaceExportObservation) => { s.recovery.active.wakePolicy = { kind: "resume_native_run" }; }],
    ["another run", (s: WorkspaceExportObservation) => { s.runs.push({ id: "run-2" }); }],
    ["host link materialized", (s: WorkspaceExportObservation) => { s.hostLinkAbsent = false; }],
    ["missing evidence", (s: WorkspaceExportObservation) => { s.runs = []; s.events = []; s.leases = []; s.recovery = {}; }],
  ] as const)("rejects %s", (_name, mutate) => {
    const state = valid(); mutate(state);
    expect(gradeWorkspaceExport(state).some(check => !check.passed)).toBe(true);
  });
  it("is one explicit native Daytona cell, excluded from --all", () => {
    const cells = runnerMatrix.filter(cell => cell.suite.id === "daytona-workspace-recovery");
    expect(cells).toHaveLength(1);
    expect(cells[0]?.profile.id).toBe("runner-codex");
    expect(cells[0]?.environment.configurationKey).toBe("warm-reuse-v1");
    expect(unsafeWorkspaceExportTask.expectedRunCount).toBe(1);
    expect(unsafeWorkspaceExportTask.buildPrompt("nonce")).toContain("/paperclip-e2e-nonexistent-nonce");
    expect(selectRunnerExecutions(parseRunnerSelectors(["--all"]), runnerMatrix).some(cell => cell.suite.id === "daytona-workspace-recovery")).toBe(false);
  });
});

describe("repaired workspace export oracle", () => {
  function fixture() {
    const before = valid(), after = structuredClone(before);
    after.issue.status = "done"; after.runs[0]!.status = "succeeded"; after.runs[0]!.nativePhase = "committed";
    after.runs[0]!.resultJson = { ...after.runs[0]!.resultJson, finalizationPhase: "committed", failureCode: null, nextAttemptAt: null };
    after.recovery.active = null;
    return { before, after, hostSafeFileMatches: true };
  }
  it("requires the same saved result and provider turn through committed export", () => {
    expect(gradeRepairedWorkspaceExport(fixture()).every(check => check.passed)).toBe(true);
  });
  it.each([
    ["another accepted result", (s: ReturnType<typeof fixture>) => { s.after.events[0]!.payload.prpEvent.payload.result.summary = "replacement"; }],
    ["provider replay on same run", (s: ReturnType<typeof fixture>) => { s.after.events.push({ payload: { prpEvent: { eventType: "turn.submitted", runId: "run-1" } } }); }],
    ["new run", (s: ReturnType<typeof fixture>) => { s.after.runs.push({ id: "run-2" }); }],
    ["host work lost", (s: ReturnType<typeof fixture>) => { s.hostSafeFileMatches = false; }],
    ["retry still pending", (s: ReturnType<typeof fixture>) => { s.after.runs[0]!.resultJson.nextAttemptAt = "later"; }],
    ["replaced sandbox", (s: ReturnType<typeof fixture>) => { s.after.leases[0]!.providerLeaseId = "new"; }],
    ["sandbox never stopped", (s: ReturnType<typeof fixture>) => { s.after.leases[0]!.status = "active"; }],
  ] as const)("rejects %s", (_label, mutate) => {
    const state = fixture(); mutate(state);
    expect(gradeRepairedWorkspaceExport(state).some(check => !check.passed)).toBe(true);
  });
});
