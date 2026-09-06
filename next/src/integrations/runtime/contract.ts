import { demand } from "../../domain/util.js";
import type { HookRuntime } from "../runtime-config/catalog.js";
export type HookName = "SessionStart" | "SessionEnd" | "PreToolUse" | "PostToolUse" | "SubagentStart" | "SubagentStop" | "PostCompact";
export type RuntimeEvent = {
    runtime: HookRuntime;
    hook: HookName;
    kind: "session_started" | "context_compacted" | "session_ended" | "tool_started" | "tool_finished" | "child_started" | "child_quiescent";
    sessionId?: string;
    cwd?: string;
    actorId?: string;
    nativeEventId?: string;
    tool?: {
        name?: string;
        id?: string;
        command?: string;
        output: string;
        succeeded: boolean;
    };
};
export type HookDecision = {
    kind: "deny" | "context";
    message: string;
} | {
    kind: "ignore";
};
export type RuntimeAdapter = {
    runtime: HookRuntime;
    decode(input: string): RuntimeEvent;
    guard(event: RuntimeEvent): HookDecision | null;
    render(event: RuntimeEvent, decision: HookDecision): Record<string, unknown>;
};
const kinds: Record<HookName, RuntimeEvent["kind"]> = { SessionStart: "session_started", SessionEnd: "session_ended", PreToolUse: "tool_started", PostToolUse: "tool_finished", SubagentStart: "child_started", SubagentStop: "child_quiescent", PostCompact: "context_compacted" };
/** The three installed profiles share a JSON envelope, not a claim of equal lifecycle semantics. */
export function commandHookAdapter(runtime: HookRuntime, childTools: readonly string[]): RuntimeAdapter {
    return {
        runtime,
        decode(input) {
            const p = JSON.parse(input);
            demand(p && typeof p === "object" && !Array.isArray(p), "INVALID_EVENT", "Hook payload must be a JSON object", 400);
            for (const key of ["hook_event_name", "session_id", "cwd", "agent_id", "tool_name", "tool_use_id", "source", "event_id", "turn_id"])
                if (p[key] !== undefined && p[key] !== null)
                    demand(typeof p[key] === "string" && p[key].length > 0 && p[key].length < 8192, "INVALID_EVENT", `Invalid runtime field: ${key}`, 400);
            demand(Object.hasOwn(kinds, p.hook_event_name), "INVALID_EVENT", "Unknown runtime event", 400);
            if (p.tool_input !== undefined)
                demand(p.tool_input && typeof p.tool_input === "object" && !Array.isArray(p.tool_input), "INVALID_EVENT", "Invalid tool_input", 400);
            if (p.tool_input?.command !== undefined)
                demand(typeof p.tool_input.command === "string", "INVALID_EVENT", "Invalid command", 400);
            const response = p.tool_response;
            const out: Record<string, unknown> = response && typeof response === "object" ? response : {};
            const hook: HookName = p.hook_event_name;
            return { runtime, hook,
                kind: hook === "SessionStart" && p.source === "compact" ? "context_compacted" : kinds[hook],
                sessionId: p.session_id ?? undefined, cwd: p.cwd ?? undefined, actorId: p.agent_id ?? undefined,
                // turn_id is not an event id: a single turn may compact more than once.
                nativeEventId: p.event_id ?? undefined,
                ...(["PreToolUse", "PostToolUse"].includes(hook) ? { tool: {
                        name: p.tool_name, id: p.tool_use_id, command: p.tool_input?.command,
                        output: typeof response === "string" ? response : typeof out.stdout === "string" ? out.stdout : typeof out.output === "string" ? out.output : "",
                        succeeded: hook === "PostToolUse" && out.is_error !== true && out.success !== false && !(typeof out.exit_code === "number" && out.exit_code !== 0) && !(typeof out.exitCode === "number" && out.exitCode !== 0),
                    } } : {}),
            };
        },
        guard(event) {
            const child = Boolean(event.actorId) || event.kind === "child_started" || event.kind === "child_quiescent";
            const childAction = event.kind === "tool_started" && childTools.includes(event.tool?.name ?? "");
            if (!child && !childAction)
                return null;
            const message = `wr-next: ${runtime} native actor has no verified per-tool work binding. Use the trusted NativeRuntimeBridge or explicit delegated runs; do not use the inherited parent context.`;
            if (event.kind === "tool_started")
                return { kind: "deny", message };
            if (event.kind === "child_started")
                return { kind: "context", message };
            return { kind: "ignore" };
        },
        render(event, decision) {
            if (decision.kind === "ignore")
                return {};
            if (decision.kind === "deny")
                return { hookSpecificOutput: { hookEventName: event.hook, permissionDecision: "deny", permissionDecisionReason: decision.message } };
            return { hookSpecificOutput: { hookEventName: event.hook, additionalContext: decision.message } };
        },
    };
}
