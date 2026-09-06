import { dirname, join } from "node:path";
import { existsSync, lstatSync } from "node:fs";
import { Client, enqueue } from "../../cli/client.js";
import { atomic, context, readJson, type ContextFile, type Connection } from "../../cli/files.js";
import { demand, digest, uid } from "../../domain/util.js";
import { capabilityConnection } from "../../runtime/binding.js";
import { resumeGuidance } from "../../runtime/guidance.js";
import { adapterVersion, type HookRuntime } from "../runtime-config/catalog.js";
import { projectRoot, requireInstalled } from "../runtime-config/project.js";
import { runtimeAdapter } from "./adapters.js";
import type { RuntimeEvent } from "./contract.js";
function print(value: Record<string, unknown>): void {
    if (Object.keys(value).length)
        console.log(JSON.stringify(value));
}
/** Existing pre-init hooks may still be executing. Route them through the same adapter. */
export function nativeGuard(payload: unknown, runtime: HookRuntime): Record<string, unknown> | null {
    const adapter = runtimeAdapter(runtime), event = adapter.decode(JSON.stringify(payload)), decision = adapter.guard(event);
    return decision ? adapter.render(event, decision) : null;
}
function lifecycleConnection(ctx: ContextFile): Connection & {
    execution: string;
} {
    // New runs have one private context. Read old sidecars only for in-flight compatibility.
    const file = process.env.WR_NEXT_RUNTIME_CONNECTION;
    if (file) {
        const stat = lstatSync(file);
        demand(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0 && (!process.getuid || stat.uid === process.getuid()), "UNSAFE_CONTEXT", "Runtime connection must be owner-private");
        const old = readJson<Connection & {
            execution: string;
        }>(file);
        demand(old.execution === ctx.execution && old.server === ctx.server && old.workspace === ctx.workspace && old.device === ctx.device && (!ctx.launcherToken || old.token === ctx.launcherToken), "RUNTIME_BINDING_CONFLICT", "Lifecycle connection does not match the work context");
        return old;
    }
    demand(ctx.launcherToken, "UNBOUND_RUNTIME_ACTOR", "No per-run lifecycle capability");
    return { ...capabilityConnection(ctx, ctx.launcherToken), execution: ctx.execution };
}
export async function runtimeEvent(input: string): Promise<void> {
    if (process.env.WR_NEXT_RUNTIME_KIND && process.env.WR_NEXT_RUNTIME_KIND !== "claude")
        return;
    const adapter = runtimeAdapter("claude"), event = adapter.decode(input), decision = adapter.guard(event);
    if (decision) {
        print(adapter.render(event, decision));
        return;
    }
    const ctx = context();
    if (!ctx || !ctx.launcherToken && !process.env.WR_NEXT_RUNTIME_CONNECTION)
        return;
    if (ctx.integration)
        return integrationEvent(input, "claude", String(adapterVersion), ctx.integration.mode, event.hook);
    await capture(event, ctx, lifecycleConnection(ctx));
}
/** Source routing happens before reading ANY parent context or credential. */
export async function integrationEvent(input: string, source: string, version: string, installation: string, expectedEvent: string): Promise<void> {
    demand(version === String(adapterVersion) && ["claude", "codex", "omp"].includes(source), "UNSUPPORTED_ADAPTER", "Unsupported runtime adapter version", 400);
    if (!process.env.WR_NEXT_CONTEXT && !process.env.WR_NEXT_BINDING_REQUIRED) {
        if (process.env.WR_NEXT_RUNTIME_KIND && process.env.WR_NEXT_RUNTIME_KIND !== source)
            return;
        if (installation === "project") {
            const { coordinatorHook } = await import("./coordinator-hook.js");
            await coordinatorHook(input, source, expectedEvent);
        }
        return;
    }
    if (process.env.WR_NEXT_RUNTIME_KIND !== source)
        return;
    const adapter = runtimeAdapter(source as HookRuntime), event = adapter.decode(input);
    demand(event.hook === expectedEvent, "INVALID_EVENT", "Static hook event differs from payload", 400);
    const decision = adapter.guard(event);
    if (decision) {
        print(adapter.render(event, decision));
        return;
    }
    const ctx = context();
    demand(ctx?.integration && ctx.integration.runtime === source && ctx.integration.adapterVersion === adapterVersion, "RUNTIME_BINDING_CONFLICT", "Installed hook has no matching run integration binding");
    if (ctx.integration.mode !== installation)
        return;
    if (installation === "project") {
        requireInstalled(ctx.integration.root, source as HookRuntime);
        if (event.cwd)
            demand(projectRoot(event.cwd) === ctx.integration.root, "RUNTIME_BINDING_CONFLICT", "Hook event is from another worktree");
    }
    const conn = lifecycleConnection(ctx);
    demand(event.sessionId && event.sessionId.length < 512, "INVALID_EVENT", "Runtime session identity required", 400);
    const receiptPath = join(dirname(process.env.WR_NEXT_CONTEXT!), "integration-seen.json");
    const previous = existsSync(receiptPath) ? readJson<{
        session: string;
        run: string;
        source: string;
    }>(receiptPath) : null;
    demand(!previous || previous.run === ctx.run && previous.session === event.sessionId && previous.source === source, "RUNTIME_BINDING_CONFLICT", "Runtime session changed; resume through a new run instead of inheriting its parent context");
    if (!previous && expectedEvent !== "SessionStart") {
        demand(expectedEvent !== "PreToolUse", "INTEGRATION_NOT_ACTIVE", "No SessionStart handshake for this run. Review hook trust and restart the runtime");
        return;
    }
    await capture(event, ctx, conn);
    if (!previous && expectedEvent === "SessionStart")
        atomic(receiptPath, { version: 1, run: ctx.run, source, session: event.sessionId, observedAt: new Date().toISOString() });
}
async function capture(event: RuntimeEvent, ctx: ContextFile, conn: Connection & {
    execution: string;
}): Promise<void> {
    if (event.kind === "session_started" || event.kind === "context_compacted") {
        if (event.sessionId) {
            try {
                await new Client(conn).command({ type: "runtime.attach", runtime: event.runtime, externalSessionId: event.sessionId, agentId: "main", invocationId: ctx.run }, { id: digest({ type: "wrapper-root", run: ctx.run, session: event.sessionId, runtime: event.runtime }), queue: true });
            }
            catch (error) {
                console.error("wr-next: root runtime attachment pending or rejected; no native child binding was inferred");
                if (ctx.integration)
                    throw error;
            }
        }
        const kind = event.kind === "context_compacted" ? "window" : "started";
        const id = kind === "started" ? digest({ type: "session-start", run: ctx.run, session: event.sessionId }) : event.nativeEventId ? digest({ type: "compact", run: ctx.run, nativeEvent: event.nativeEventId }) : uid("runtimeop");
        enqueue(conn, "/v1/observations", { schemaVersion: 1, operationId: id, command: { type: "runtime.event", execution: ctx.execution, event: kind, externalSessionId: event.sessionId, windowId: kind === "window" ? id : undefined } });
        print(runtimeAdapter(event.runtime).render(event, { kind: "context", message: await resumeGuidance(ctx) }));
    }
    if (event.kind === "tool_finished" && event.tool?.succeeded && /\bgh\s+pr\s+(create|merge)\b/.test(event.tool.command ?? "")) {
        const urls = [...new Set(event.tool.output.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g) ?? [])];
        if (urls.length === 1) {
            const path = new URL(urls[0]!).pathname.split("/");
            const { syncPr } = await import("../github.js");
            await syncPr(ctx, `${path[1]}/${path[2]}`, Number(path[4]));
        }
    }
    // session_ended / child_quiescent are NOT process_stopped. No reservation release.
}
