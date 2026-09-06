import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { Client, enqueue, syncOutbox } from "../cli/client.js";
import { atomic, context, stateHome, readJson, type ContextFile, type Connection } from "../cli/files.js";
import { uid, demand, digest } from "../domain/util.js";
import { cliPath } from "../git/hooks.js";
import { claudeChildGuard } from "./claude-guard.js";
import { git, tryGit } from "../git/repository.js";
export type LaunchOptions = {
    work: string;
    argv: string[];
    cwd?: string;
    runtime?: string;
    role?: string;
    readOnly?: boolean;
    continuedFrom?: string;
    session?: string;
    worktree?: string;
};
type StartResponse = {
    result: {
        execution: string;
        run: string;
        work: string;
        key: string;
        scopeRevision: number;
        generation: number;
        environment: string;
    };
    capabilities: {
        worker: string;
        launcher: string;
        git: string;
        github: string;
    };
};
const q = (x: string) => `'${x.replaceAll("'", `'\\''`)}'`;
export async function launch(cfg: Connection, options: LaunchOptions): Promise<{
    exitCode: number;
    execution: string;
    receipt: string;
}> {
    demand(options.argv.length, "INVALID_COMMAND", "Provide command after --");
    const launchId = uid("launch"), dir = join(stateHome(), "launches", launchId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    let cwd = resolve(options.cwd ?? process.cwd());
    if (options.worktree) {
        const location = resolve(options.worktree);
        demand(!existsSync(location), "WORKTREE_EXISTS", "Automatic worktree creation requires a new path");
        git(cwd, ["worktree", "add", "-b", `wr-next/${launchId}`, location]);
        cwd = location;
    }
    const environment = tryGit(cwd, ["rev-parse", "--path-format=absolute", "--git-dir"]) ?? cwd;
    const client = new Client(cfg), parent = context();
    let delegationToken: string | undefined;
    if (parent) {
        const d = await client.command({ type: "delegation.issue", work: options.work, objective: `Delegated work ${options.work}`, role: options.role ?? "implementer", mode: options.readOnly ? "read" : "write" });
        delegationToken = d.result.token;
    }
    const start = await client.command<StartResponse>({ type: "execution.start", work: options.work, launchId, environment, runtime: options.runtime ?? "generic", role: options.role ?? "implementer", mode: options.readOnly ? "read" : "write", continuedFrom: options.continuedFrom, session: options.session, delegationToken }, { id: launchId });
    const ctx: ContextFile = { ...cfg, ...start.result, ...(!cfg.accessToken && !cfg.token.startsWith("wn1.") && cfg.token.split(".").length === 3 ? { accessToken: cfg.token } : {}), token: start.capabilities.worker, gitToken: start.capabilities.git, launcherToken: start.capabilities.launcher, githubToken: start.capabilities.github, contributors: [] };
    const ctxPath = join(dir, "context.json"), receiptPath = join(dir, "receipt.json");
    atomic(ctxPath, ctx);
    const receipt = { launchId, execution: ctx.execution, run: ctx.run, cwd, executable: basename(options.argv[0]!), argumentCount: options.argv.length - 1, state: "prepared", process: null as unknown };
    atomic(receiptPath, receipt);
    const bin = join(dir, "bin");
    mkdirSync(bin, { mode: 0o700 });
    writeFileSync(join(bin, "wr-next"), `#!/bin/sh\nexec ${q(process.execPath)} ${q(cliPath())} "$@"\n`, { mode: 0o700 });
    const childEnv = { ...process.env, WR_NEXT_CONTEXT: ctxPath, PATH: `${bin}:${process.env.PATH ?? ""}` };
    for (const key of ["WR_NEXT_BINDING_REQUIRED", "WR_NEXT_RUNTIME_AGENT", "WR_NEXT_TOKEN", "WR_NEXT_SERVER", "WR_NEXT_RUNTIME_CONNECTION", "WR_SESSION_RUN_ID", "WR_CLI_SESSION", "WR_EXECUTION_ID", "CODEX_THREAD_ID", "CLAUDE_CODE_SESSION_ID", "DEVIN_SESSION_ID", "PI_SESSION_ID"])
        delete (childEnv as NodeJS.ProcessEnv)[key];
    let argv = [...options.argv];
    if (options.runtime === "claude") {
        const eventCommand = `${q(process.execPath)} ${q(cliPath())} internal runtime-event`;
        const settings = { hooks: { PreToolUse: [{ hooks: [{ type: "command", command: eventCommand }] }], SubagentStart: [{ hooks: [{ type: "command", command: eventCommand }] }], SubagentStop: [{ hooks: [{ type: "command", command: eventCommand }] }], SessionStart: [{ hooks: [{ type: "command", command: eventCommand }] }], SessionEnd: [{ hooks: [{ type: "command", command: eventCommand }] }], PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: eventCommand, async: true }] }] } };
        const path = join(dir, "claude-settings.json");
        atomic(path, settings);
        argv = [argv[0]!, "--settings", path, ...argv.slice(1)];
        // Runtime observations use a launcher capability, not arbitrary trusted check authority.
        atomic(join(dir, "runtime-connection.json"), { ...cfg, accessToken: ctx.accessToken, token: start.capabilities.launcher, execution: ctx.execution });
        (childEnv as NodeJS.ProcessEnv).WR_NEXT_RUNTIME_CONNECTION = join(dir, "runtime-connection.json");
    }
    const observe = (command: unknown) => enqueue({ ...cfg, accessToken: ctx.accessToken, token: start.capabilities.launcher }, "/v1/observations", { schemaVersion: 1, operationId: uid("runop"), command });
    let child: ReturnType<typeof spawn>;
    try {
        child = spawn(argv[0]!, argv.slice(1), { cwd, env: childEnv, stdio: "inherit" });
    }
    catch (error) {
        observe({ type: "runtime.event", execution: ctx.execution, event: "launch_failed", exitCode: 127 });
        receipt.state = "failed";
        atomic(receiptPath, receipt);
        await syncOutbox();
        throw error;
    }
    const exited = await new Promise<{
        code: number;
        signal: NodeJS.Signals | null;
    }>((resolve) => {
        const onSignal = (signal: NodeJS.Signals) => { child.kill(signal); };
        const term = () => onSignal("SIGTERM"), interrupt = () => onSignal("SIGINT");
        process.on("SIGTERM", term);
        process.on("SIGINT", interrupt);
        child.once("spawn", () => {
            const startIdentity = processIdentity(child.pid!);
            receipt.state = "running";
            receipt.process = { pid: child.pid, startIdentity, nonce: uid("process") };
            atomic(receiptPath, receipt);
            observe({ type: "runtime.event", execution: ctx.execution, event: "started" });
        });
        const finish = (code: number, signal: NodeJS.Signals | null) => { process.off("SIGTERM", term); process.off("SIGINT", interrupt); resolve({ code, signal }); };
        child.once("error", () => finish(127, null));
        child.once("exit", (code, signal) => finish(code ?? (signal === "SIGINT" ? 130 : 143), signal));
    });
    receipt.state = "ended";
    atomic(receiptPath, { ...receipt, exitCode: exited.code, signal: exited.signal });
    observe({ type: "runtime.event", execution: ctx.execution, event: exited.code === 127 ? "launch_failed" : "ended", exitCode: exited.code, signal: exited.signal ?? undefined });
    const synced = await syncOutbox();
    if (synced.pending || synced.conflicts.length)
        console.error(`wr-next: ${synced.pending} pending, ${synced.conflicts.length} conflicts; execution receipt retained`);
    return { exitCode: exited.code, execution: ctx.execution, receipt: receiptPath };
}
export function processIdentity(pid: number): string | null {
    try {
        if (process.platform === "linux") {
            const fields = readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /, "").split(" ");
            return fields[0] === "Z" || fields[0] === "X" ? null : fields[19] ?? null;
        }
        const p = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
        return p.status === 0 ? p.stdout.trim() : null;
    }
    catch {
        return null;
    }
}
export async function runtimeEvent(input: string): Promise<void> {
    // Check the runtime-provided actor before touching an inherited context or
    // any parent capability. A missing/corrupt context must not turn this into allow.
    const parsed = JSON.parse(input) as {
        hook_event_name?: string;
        agent_id?: unknown;
        tool_name?: string;
    };
    const guard = claudeChildGuard(parsed);
    if (guard) {
        if (Object.keys(guard).length)
            console.log(JSON.stringify(guard));
        return;
    }
    const file = process.env.WR_NEXT_RUNTIME_CONNECTION;
    const ctx = context();
    if (!file || !ctx)
        return;
    const conn = readJson<Connection & {
        execution: string;
    }>(file), payload = JSON.parse(input) as {
        hook_event_name?: string;
        session_id?: string;
        source?: string;
        tool_input?: {
            command?: string;
        };
        tool_response?: unknown;
    };
    if (payload.hook_event_name === "SessionStart") {
        if (payload.session_id) {
            try {
                // The root is explicitly observed by this wrapper. This does NOT bind
                // native children or grant the model a root-adapter capability.
                await new Client(conn).command({ type: "runtime.attach", runtime: "claude", externalSessionId: payload.session_id, agentId: "main", invocationId: ctx.run }, { id: digest({ type: "wrapper-root", run: ctx.run, session: payload.session_id }), queue: true });
            }
            catch {
                console.error("wr-next: root runtime attachment pending or rejected; no native child binding was inferred");
            }
        }
        const event = payload.source === "compact" ? "window" : "started";
        enqueue(conn, "/v1/observations", { schemaVersion: 1, operationId: uid("runtimeop"), command: { type: "runtime.event", execution: ctx.execution, event, externalSessionId: payload.session_id, windowId: event === "window" ? uid("window") : undefined } });
        let guidance = `You are working on ${ctx.key}. Use wr-next status to read current requirements and state. Use wr-next report for decisions/blockers; wr-next done --summary to submit. Submission is not unconditional acceptance. Do not repeat external actions based only on old handoff prose. Context-window rollover continues the same Execution.`;
        try {
            const view = await new Client(ctx).request<{
                work: {
                    title: string;
                    description: string;
                    scopeRevision: number;
                };
            }>(`/v1/work?work=${encodeURIComponent(ctx.work)}`);
            guidance += `\nTitle: ${view.work.title}\nRequirements: ${view.work.description.slice(0, 4000)}\nScope revision at start: ${ctx.scopeRevision}; current: ${view.work.scopeRevision}.`;
            if (view.work.description.length > 4000)
                guidance += " Requirements truncated: retrieve /v1/work through wr-next status before acting.";
        }
        catch {
            guidance += " Current authority unavailable: read live state before taking external actions; completion cannot be assumed.";
        }
        console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: guidance } }));
    }
    if (payload.hook_event_name === "PostToolUse" && /\bgh\s+pr\s+(create|merge)\b/.test(payload.tool_input?.command ?? "")) {
        const response = payload.tool_response;
        const responseObject = typeof response === "object" && response !== null ? response as Record<string, unknown> : {};
        const output = typeof response === "string" ? response : typeof responseObject.stdout === "string" ? responseObject.stdout : typeof responseObject.output === "string" ? responseObject.output : "";
        if (responseObject.is_error === true)
            return;
        const urls = [...new Set(output.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g) ?? [])];
        if (urls.length === 1) {
            const path = new URL(urls[0]!).pathname.split("/");
            const { syncPr } = await import("../integrations/github.js");
            await syncPr(ctx, `${path[1]}/${path[2]}`, Number(path[4]));
        }
    }
    // SessionEnd is not proof the OS process released the writer; the parent launcher owns that observation.
}
