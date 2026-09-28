import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import type { WorkspaceExportObservation } from "./workspace-export-scoring.js";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
/** Operator action through the official provider SDK, limited to the fixture's exact stopped lease. */
export async function repairFixtureWorkspaceExport(input: {
  observed: WorkspaceExportObservation; companyId: string; environmentId: string; nonce: string; apiKey?: string;
}) {
  if (!input.apiKey || !/^[a-zA-Z0-9_-]+$/.test(input.nonce)) throw new Error("Workspace repair fixture configuration is missing");
  const run = input.observed.runs[0];
  const leases = input.observed.leases.filter(lease => lease.heartbeatRunId === run?.id);
  const lease = leases[0];
  const reference = run?.runnerProfileJson?.nativeWorkspaceSync;
  if (input.observed.runs.length !== 1 || leases.length !== 1 || lease?.companyId !== input.companyId
    || lease.environmentId !== input.environmentId || lease.issueId !== input.observed.issue.id
    || lease.status !== "released" || lease.cleanupStatus !== "success"
    || lease.metadata?.remoteExecutionTermination?.state !== "stopped"
    || reference?.leaseId !== lease.id || reference?.providerLeaseId !== lease.providerLeaseId
    || reference?.remoteCwd !== lease.metadata?.remoteCwd || typeof reference?.remoteCwd !== "string") {
    throw new Error("Workspace repair fixture does not own an exact stopped sandbox");
  }
  // The provider package owns and pins the SDK dependency. It is never imported
  // by the credential-free grader and no SDK response or credential is logged.
  const require = createRequire(path.resolve("packages/plugins/sandbox-providers/daytona/package.json"));
  const { Daytona } = require("@daytonaio/sdk") as { Daytona: new (input: { apiKey: string }) => { get(id: string): Promise<{
    id: string; state: string; labels?: Record<string, string>; start(timeout: number): Promise<void>;
    process: { executeCommand(command: string, cwd: string, env: undefined, timeout: number): Promise<{ exitCode: number; result: string }> };
  }> } };
  const expectedBytes = `PRESERVED-${input.nonce}\n`;
  const expectedSha256 = createHash("sha256").update(expectedBytes).digest("hex");
  try {
    const sandbox = await new Daytona({ apiKey: input.apiKey }).get(lease.providerLeaseId);
    const expectedLabels = { "paperclip-company-id": input.companyId, "paperclip-environment-id": input.environmentId,
      "paperclip-run-id": run.id, "paperclip-create-attempt": String(lease.metadata?.sandboxName).replace(/^paperclip-create-/, "") };
    if (sandbox.id !== lease.providerLeaseId || !["stopped", "archived"].includes(sandbox.state)
      || Object.entries(expectedLabels).some(([key, value]) => sandbox.labels?.[key] !== value)) throw new Error("scope");
    await sandbox.start(60);
    const data = JSON.stringify({ root: reference.remoteCwd, nonce: input.nonce, expectedSha256 });
    const program = ["import os,json,hashlib,stat", `f=json.loads(${JSON.stringify(data)})`,
      "link=os.path.join(f['root'],'unsafe-export-'+f['nonce'])", "safe=os.path.join(f['root'],'safe-work-'+f['nonce']+'.txt')",
      "assert os.path.islink(link) and os.readlink(link)=='/paperclip-e2e-nonexistent-'+f['nonce']",
      "assert stat.S_ISREG(os.lstat(safe).st_mode)", "assert hashlib.sha256(open(safe,'rb').read()).hexdigest()==f['expectedSha256']",
      "os.unlink(link)", "assert not os.path.lexists(link)", "assert hashlib.sha256(open(safe,'rb').read()).hexdigest()==f['expectedSha256']",
      "print(json.dumps({'removedOnlySyntheticLink':True,'safeFileSha256':f['expectedSha256']}))"].join("\n");
    const result = await sandbox.process.executeCommand(`python3 -c ${quote(program)}`, "/", undefined, 15);
    if (result.exitCode !== 0) throw new Error("repair");
    const receipt = JSON.parse(result.result.trim());
    if (receipt.removedOnlySyntheticLink !== true || receipt.safeFileSha256 !== expectedSha256) throw new Error("receipt");
    return { runId: run.id, leaseId: lease.id, providerLeaseId: lease.providerLeaseId, ...receipt };
  } catch {
    throw new Error("Exact fixture sandbox repair failed; provider details withheld. The normal fixture cleanup retains ownership.");
  }
}
