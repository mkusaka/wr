/** Static project integration contracts. No Work/Run ID or credential belongs here. */
export const runtimeNames = ["claude", "codex", "omp", "devin"] as const;
export type RuntimeName = typeof runtimeNames[number];
export type HookRuntime = Exclude<RuntimeName, "devin">;
export const adapterVersion = 1;
export const configPath = ".wr/config.json";
export const configPaths = {
    claude: ".claude/settings.json",
    codex: ".codex/hooks.json",
    omp: ".omp/extensions/wr-next.ts",
} as const;
export const commands = Object.fromEntries(["claude", "codex", "omp"].map(name => [name,
    `wr-next internal integration-event --source ${name} --adapter-version ${adapterVersion} --installation project`,
])) as Record<HookRuntime, string>;
export type HookGroup = {
    hooks: {
        type: "command";
        command: string;
        timeout: number;
    }[];
};
export function groups(runtime: "claude" | "codex"): Record<string, HookGroup> {
    // No approval handler, async handler, trust bypass, or duplicate inline TOML definition.
    return Object.fromEntries(["SessionStart", "SessionEnd", "PreToolUse", "PostToolUse", ...(runtime === "claude" ? ["PostToolUseFailure", "PostToolBatch", "PermissionDenied"] : []), "SubagentStart", "SubagentStop"].map(event => [event,
        { hooks: [{ type: "command", command: `${commands[runtime]} --event ${event}`, timeout: event === "SessionEnd" ? 3 : 20 }] },
    ]));
}
export function runtimeName(input: string): RuntimeName {
    if (!runtimeNames.includes(input as RuntimeName))
        throw new Error(`Unknown runtime: ${input}`);
    return input as RuntimeName;
}
/** A standalone, project-discovered OMP factory; no import of machine-local wr-next paths. */
export function ompExtension(): string {
    return `// wr-next managed integration v1 — regenerate with wr-next integrations sync.
// No Work/Execution IDs or credentials are persisted in this file.
import { spawn } from "node:child_process";

type Value = Record<string, unknown>;
type Context = {
    cwd: string;
    sessionManager?: { getSessionId?: () => unknown };
    ui?: { notify?: (message: string, kind: "warning") => void };
};
type Host = {
    [key: symbol]: unknown;
    on(name: string, handler: (event: Value, ctx: Context) => unknown): void;
};
const object = (value: unknown): Value => value !== null && typeof value === "object" ? value as Value : {};

export default function wrNext(pi: Host): void {
    // The host API instance changes on reload. Do not retain a process-global loaded flag.
    const key = Symbol.for("wr-next:omp:v1");
    if (pi[key]) return;
    pi[key] = true;
    let guidance = "";
    async function dispatch(event: Value, ctx: Context): Promise<Value> {
        if (process.env.WR_NEXT_RUNTIME_KIND && process.env.WR_NEXT_RUNTIME_KIND !== "omp") return {};
        const session = ctx.sessionManager?.getSessionId?.();
        if (typeof session !== "string" || !session) throw new Error("wr-next: OMP session identity unavailable");
        const { promise, resolve, reject } = Promise.withResolvers<Value>();
        const child = spawn("wr-next", ["internal", "integration-event", "--source", "omp", "--adapter-version", "1", "--installation", "project", "--event", String(event.hook_event_name)], {
            cwd: ctx.cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"],
        });
        let output = "", errors = "", settled = false;
        const finish = (error?: Error, value?: Value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value ?? {}); };
        const timer = setTimeout(() => { child.kill(); finish(new Error("wr-next: integration timeout")); }, 18000);
        child.on("error", error => finish(error instanceof Error ? error : new Error(String(error))));
        child.stdin.on("error", error => finish(error instanceof Error ? error : new Error(String(error))));
        child.stdout.on("data", chunk => { output += String(chunk); if (output.length > 131072) { child.kill(); finish(new Error("wr-next: oversized hook response")); } });
        child.stderr.on("data", chunk => { errors = (errors + String(chunk)).slice(-4096); });
        child.on("close", code => {
            if (code !== 0) return finish(new Error(errors || "wr-next: hook failed"));
            try { finish(undefined, object(output.trim() ? JSON.parse(output) : {})); } catch { finish(new Error("wr-next: malformed hook response")); }
        });
        child.stdin.end(JSON.stringify({ ...event, session_id: session, cwd: ctx.cwd }));
        return await promise;
    }
    const warn = (ctx: Context, error: unknown) => ctx.ui?.notify?.(String(error), "warning");
    pi.on("session_start", async (_event, ctx) => {
        try {
            const decision = object((await dispatch({ hook_event_name: "SessionStart", source: "startup" }, ctx)).hookSpecificOutput);
            guidance = typeof decision.additionalContext === "string" ? decision.additionalContext : "";
        }
        catch (error) { warn(ctx, error); }
    });
    pi.on("session_compact", async (event, ctx) => {
        try {
            const decision = object((await dispatch({ hook_event_name: "SessionStart", source: "compact", event_id: object(event.compactionEntry).id }, ctx)).hookSpecificOutput);
            guidance = typeof decision.additionalContext === "string" ? decision.additionalContext : "";
        }
        catch (error) { warn(ctx, error); }
    });
    pi.on("before_agent_start", () => {
        if (!guidance) return;
        const content = guidance; guidance = "";
        return { message: { customType: "wr-next-context", content, display: false } };
    });
    pi.on("tool_call", async (event, ctx) => {
        try {
            const result = await dispatch({ hook_event_name: "PreToolUse", tool_name: event.toolName, tool_input: event.input, tool_use_id: event.toolCallId }, ctx);
            const decision = object(result.hookSpecificOutput);
            if (decision.permissionDecision === "deny") return { block: true, reason: String(decision.permissionDecisionReason ?? "wr-next denied the tool") };
            if (decision.updatedInput !== undefined) return { input: object(decision.updatedInput) };
        } catch (error) { return { block: true, reason: String(error) }; }
    });
    pi.on("tool_result", async (event, ctx) => {
        const content = Array.isArray(event.content) ? event.content.map(object) : [];
        try { await dispatch({ hook_event_name: event.isError ? "PostToolUseFailure" : "PostToolUse", tool_name: event.toolName, tool_input: event.input, tool_use_id: event.toolCallId,
            tool_response: { is_error: event.isError, output: content.filter(item => item.type === "text").map(item => String(item.text ?? "")).join("\\n") } }, ctx); }
        catch (error) { warn(ctx, error); }
    });
    pi.on("session_shutdown", async (_event, ctx) => {
        try { await dispatch({ hook_event_name: "SessionEnd" }, ctx); } catch (error) { warn(ctx, error); }
        // Session shutdown is advisory. A supervised launcher owns definitive OS termination.
    });
}
`;
}
