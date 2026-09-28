import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";

const sync = vi.hoisted(() => ({ resume: vi.fn() }));
vi.mock("./native-workspace-finalization-ownership.js", () => ({
  withNativeWorkspaceFinalizationOwnership: async (_input: unknown, action: (owner: unknown) => unknown) =>
    ({ acquired: true, value: await action({ token: "fixture-owner", assertHeld: async () => {} }) }),
}));
vi.mock("./native-workspace-sync.js", () => ({
  readNativeWorkspaceSyncReference: () => ({ leaseId: "lease", providerLeaseId: "sandbox", workspaceId: "workspace" }),
  resumeNativeWorkspaceSync: sync.resume,
}));
vi.mock("../environments.js", () => ({ environmentService: () => ({
  getLeaseById: async () => ({ id: "lease", companyId: "company", environmentId: "environment", providerLeaseId: "sandbox", status: "active" }),
  getById: async () => ({ id: "environment", companyId: "company" }),
}) }));
vi.mock("../environment-execution-target.js", () => ({ resolveEnvironmentExecutionTarget: async () => ({ kind: "remote" }) }));
vi.mock("../workspace-operations.js", () => ({ workspaceOperationService: () => ({
  createRecorder: () => ({ recordOperation: async (input: { run: () => Promise<unknown> }) => input.run() }),
}) }));
import { classifyNativeWorkspaceFailure } from "./native-workspace-failure.js";
import { resumeNativeWorkspaceFinalization } from "./native-workspace-finalizer.js";

function fixtureDb(): Db {
  const responses = [[{
    companyId: "company", runtimeMode: "native", issueId: "issue", resultId: "result",
    runnerProfileJson: { nativeWorkspaceSync: {}, nativeExecutionInput: { binding: {} } },
  }], [{ phase: "result_accepted", nextAttemptAt: null, resultId: "result" }], []];
  return { select: () => {
    const query = {
      from: () => query, innerJoin: () => query, where: () => query, orderBy: () => query,
      limit: async () => responses.shift() ?? [],
    };
    return query;
  } } as unknown as Db;
}

describe("native workspace finalization failure classification", () => {
  beforeEach(() => sync.resume.mockReset());
  it.each([
    ["Daytona syncOut refusing tarball link whose target escapes the extraction dir: .worktrees/task/.tools/pnpm -> ../../../../../../usr/share/nodejs/corepack/dist/pnpm.js", "workspace_sync_out_unsafe_archive"],
    ["Daytona syncOut refusing tarball member that escapes the extraction dir: ../private", "workspace_sync_out_unsafe_archive"],
    ["daytona_sandbox_not_found", "workspace_sync_out_unrecoverable"],
    ["Daytona syncOut directory download failed: timeout", "workspace_sync_out_failed"],
  ])("retains a stable code for %s", async (message, expectedCode) => {
    sync.resume.mockRejectedValueOnce(new Error(message));
    const result = await resumeNativeWorkspaceFinalization({ db: fixtureDb(), runId: "run", environmentRuntime: {} as never });
    expect(result).toMatchObject({
      status: "failed", exitCode: 1,
      stderr: `${expectedCode}\n`, metadata: { workspaceSync: { code: expectedCode } },
    });
    expect(sync.resume).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain(".tools/pnpm");
  });
});


describe("native workspace retry policy", () => {
  it.each([
    [new Error("workspace_sync_out_unsafe_archive\n"), "workspace_sync_out_unsafe_archive", true],
    [Object.assign(new Error("redacted"), { code: "WORKSPACE_RESTORE_UNSAFE_ARCHIVE" }), "workspace_sync_out_unsafe_archive", true],
    [new Error("Daytona outbound symlink-escape guard command failed (exit 44)"), "workspace_sync_out_unsafe_archive", true],
    [new Error("Daytona outbound symlink-escape guard command failed (exit 1)"), "workspace_sync_out_failed", false],
    [new Error("archive network download failed"), "workspace_sync_out_failed", false],
    [new Error("workspace_sync_out_unrecoverable\n"), "workspace_sync_out_unrecoverable", true],
  ])("classifies %s without leaking details", (error, code, permanent) => {
    expect(classifyNativeWorkspaceFailure(error)).toEqual({ code, failureCode: `native_${code}`, permanent });
  });
});
