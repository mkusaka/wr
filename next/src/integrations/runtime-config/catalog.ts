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
        { hooks: [{ type: "command", command: `${commands[runtime]} --event ${event}`, timeout: 20 }] },
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

export default function wrNext(pi: any): void {
    // The host API instance changes on reload. Do not retain a process-global loaded flag.
    const key = Symbol.for("wr-next:omp:v1");
    if (pi[key]) return;
    pi[key] = true;
    let guidance = "";
    const enabled = () => process.env.WR_NEXT_RUNTIME_KIND === "omp" && Boolean(process.env.WR_NEXT_CONTEXT);
    async function dispatch(event: Record<string, unknown>, ctx: any): Promise<any> {
        if (!enabled()) return {};
        const session = ctx.sessionManager?.getSessionId?.();
        if (typeof session !== "string" || !session) throw new Error("wr-next: OMP session identity unavailable");
        return await new Promise((resolve, reject) => {
            const child = spawn("wr-next", ["internal", "integration-event", "--source", "omp", "--adapter-version", "1", "--installation", "project", "--event", String(event.hook_event_name)], {
                cwd: ctx.cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"],
            });
            let output = "", errors = "", settled = false;
            const finish = (error?: Error, value?: any) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
            const timer = setTimeout(() => { child.kill(); finish(new Error("wr-next: integration timeout")); }, 18000);
            child.on("error", e => finish(e));
            child.stdin.on("error", e => finish(e));
            child.stdout.on("data", b => { output += b; if (output.length > 131072) { child.kill(); finish(new Error("wr-next: oversized hook response")); } });
            child.stderr.on("data", b => { errors = (errors + b).slice(-4096); });
            child.on("close", code => {
                if (code !== 0) return finish(new Error(errors || "wr-next: hook failed"));
                try { finish(undefined, output.trim() ? JSON.parse(output) : {}); } catch { finish(new Error("wr-next: malformed hook response")); }
            });
            child.stdin.end(JSON.stringify({ ...event, session_id: session, cwd: ctx.cwd }));
        });
    }
    const warn = (ctx: any, e: unknown) => ctx.ui?.notify?.(String(e), "warning");
    pi.on("session_start", async (_event: any, ctx: any) => {
        try { guidance = (await dispatch({ hook_event_name: "SessionStart", source: "startup" }, ctx)).hookSpecificOutput?.additionalContext || ""; }
        catch (e) { warn(ctx, e); }
    });
    pi.on("session_compact", async (event: any, ctx: any) => {
        try { guidance = (await dispatch({ hook_event_name: "SessionStart", source: "compact", event_id: event.compactionEntry?.id }, ctx)).hookSpecificOutput?.additionalContext || ""; }
        catch (e) { warn(ctx, e); }
    });
    pi.on("before_agent_start", () => {
        if (!enabled() || !guidance) return;
        const content = guidance; guidance = "";
        return { message: { customType: "wr-next-context", content, display: false } };
    });
    pi.on("tool_call", async (event: any, ctx: any) => {
        if (!enabled()) return;
        try {
            const result = await dispatch({ hook_event_name: "PreToolUse", tool_name: event.toolName, tool_input: event.input, tool_use_id: event.toolCallId }, ctx);
            const decision = result.hookSpecificOutput;
            if (decision?.permissionDecision === "deny") return { block: true, reason: decision.permissionDecisionReason };
        } catch (e) { return { block: true, reason: String(e) }; }
    });
    pi.on("tool_result", async (event: any, ctx: any) => {
        if (!enabled() || !/\\bgh\\s+pr\\s+(create|merge)\\b/.test(String(event.input?.command ?? ""))) return;
        try { await dispatch({ hook_event_name: "PostToolUse", tool_name: event.toolName, tool_input: event.input, tool_use_id: event.toolCallId,
            tool_response: { is_error: event.isError, output: (event.content || []).filter((x: any) => x.type === "text").map((x: any) => x.text).join("\\n") } }, ctx); }
        catch (e) { warn(ctx, e); }
    });
    pi.on("session_shutdown", async (_event: any, ctx: any) => {
        try { await dispatch({ hook_event_name: "SessionEnd" }, ctx); } catch (e) { warn(ctx, e); }
        // Session shutdown is advisory. The launcher owns OS termination/reservations.
    });
}
`;
}
