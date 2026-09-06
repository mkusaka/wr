import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { Client, enqueue, syncOutbox } from "../cli/client.js";
import { atomic, context, stateHome, type ContextFile, type Connection } from "../cli/files.js";
import { cliPath, shellQuote } from "../cli/entrypoint.js";
import { uid, demand, digest } from "../domain/util.js";
import { capabilityConnection, writeExecutionContext, type ExecutionBinding, type WorkCapabilities } from "./binding.js";
import { cleanWorkEnvironment } from "./environment.js";
import { processIdentity } from "./process.js";
export { processIdentity } from "./process.js";
import { supervise } from "./supervisor.js";
export type LaunchOptions = {
    work?: string;
    selectionGrant?: string;
    argv: string[];
    cwd?: string;
    environment?: string;
    runtime?: string;
    role?: string;
    readOnly?: boolean;
    continuedFrom?: string;
    session?: string;
    integration?: ContextFile["integration"];
    env?: NodeJS.ProcessEnv;
};
export type LaunchResult = {
    idle?: boolean;
    exitCode: number;
    execution: string;
    receipt: string;
};
type StartResponse = {
    result: ExecutionBinding;
    capabilities: WorkCapabilities;
};
/** Bind work to an explicit argv and supervise it. No runtime discovery/configuration. */
export async function launch(cfg: Connection, options: LaunchOptions): Promise<LaunchResult> {
    demand(options.argv.length && options.argv.every(x => typeof x === "string" && !x.includes("\0")), "INVALID_COMMAND", "Provide a valid argv after --");
    const launchId = uid("launch"), dir = join(stateHome(), "launches", launchId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const cwd = resolve(options.cwd ?? process.cwd()), runtime = options.runtime ?? "generic";
    const client = new Client(cfg), parent = context();
    let delegationToken: string | undefined;
    if (parent) {
        const grant = await client.command({ type: "delegation.issue", work: options.work, objective: `Delegated work ${options.work}`, role: options.role ?? "implementer", mode: options.readOnly ? "read" : "write" });
        delegationToken = grant.result.token;
    }
    demand(Boolean(options.work) !== Boolean(options.selectionGrant), "INVALID_COMMAND", "Select explicit work or an approved next-work scope");
    const started = await client.command<StartResponse | {
        result: {
            idle: true;
            reason: string;
        };
    }>({ type: options.selectionGrant ? "execution.next" : "execution.start", ...(options.selectionGrant ? { grant: options.selectionGrant } : { work: options.work }), launchId,
        environment: options.environment ?? cwd, runtime, role: options.role ?? "implementer", mode: options.readOnly ? "read" : "write",
        continuedFrom: options.continuedFrom, session: options.session, delegationToken }, { id: launchId });
    if ("idle" in started.result) {
        const receipt = join(dir, "receipt.json");
        atomic(receipt, { launchId, state: "idle", reason: started.result.reason, process: null });
        return { idle: true, exitCode: 0, execution: "", receipt };
    }
    const start = started as StartResponse;
    const ctxPath = join(dir, "context.json"), receiptPath = join(dir, "receipt.json");
    const observationConnection = capabilityConnection(cfg, start.capabilities.launcher);
    const receipt = { launchId, execution: start.result.execution, run: start.result.run, cwd,
        executable: basename(options.argv[0]!), argumentCount: options.argv.length - 1,
        processOwnership: "direct-child", state: "prepared", process: null as unknown };
    const observe = (event: string, details: Record<string, unknown> = {}) => enqueue(observationConnection, "/v1/observations", {
        schemaVersion: 1, operationId: digest({ launchId, event }), command: { type: "runtime.event", execution: start.result.execution, event, ...details }
    });
    const record = (fn: () => void) => {
        try {
            fn();
        }
        catch {
            console.error("wr-next: local runtime record failed; inspect the retained launch intent before recovering reservations");
        }
    };
    let childEnv: NodeJS.ProcessEnv;
    try {
        // Persist context and preparation receipt BEFORE allowing code to execute.
        atomic(receiptPath, receipt);
        writeExecutionContext(ctxPath, cfg, start.result, start.capabilities, options.integration);
        const bin = join(dir, "bin");
        mkdirSync(bin, { mode: 0o700 });
        writeFileSync(join(bin, "wr-next"), `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(cliPath())} "$@"\n`, { mode: 0o700 });
        childEnv = { ...cleanWorkEnvironment(options.env), WR_NEXT_HOME: stateHome(), WR_NEXT_RUNTIME_KIND: runtime, WR_NEXT_CONTEXT: ctxPath,
            PATH: `${bin}:${options.env?.PATH ?? process.env.PATH ?? ""}` };
    }
    catch (error) {
        // No spawn has occurred. This proof is different from an ambiguous runtime failure.
        receipt.state = "failed";
        record(() => atomic(receiptPath, { ...receipt, failure: "preparation_failed" }));
        record(() => observe("launch_failed", { exitCode: 127 }));
        await syncOutbox();
        throw error;
    }
    const outcome = await supervise(options.argv, cwd, childEnv, {
        started(pid) {
            receipt.state = "running";
            receipt.process = { pid, startIdentity: processIdentity(pid), nonce: uid("process") };
            atomic(receiptPath, receipt);
            observe("started");
        },
        uncertain() {
            receipt.state = "unknown";
            record(() => atomic(receiptPath, receipt));
            record(() => observe("unknown"));
            console.error("wr-next: child liveness is uncertain; retaining ownership until actual exit is observed");
        },
    });
    receipt.state = outcome.kind === "spawn_failed" ? "failed" : "ended";
    record(() => atomic(receiptPath, { ...receipt, exitCode: outcome.code, signal: outcome.signal, outcome: outcome.kind }));
    // A program that exits 127 WAS launched. Never fabricate launch_failed from its code.
    record(() => observe(outcome.kind === "spawn_failed" ? "launch_failed" : "ended", { exitCode: outcome.code, ...(outcome.signal ? { signal: outcome.signal } : {}) }));
    try {
        const synced = await syncOutbox();
        if (synced.pending || synced.conflicts.length)
            console.error(`wr-next: ${synced.pending} pending, ${synced.conflicts.length} conflicts; execution receipt retained`);
    }
    catch {
        console.error("wr-next: observation sync failed; child exit is recorded locally where possible");
    }
    return { exitCode: outcome.code, execution: start.result.execution, receipt: receiptPath };
}
