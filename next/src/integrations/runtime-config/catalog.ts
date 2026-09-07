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
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { spawn } from "node:child_process";

type Value = Record<string, unknown>;
type TaskBinding = { agentId: string; parentSessionId: string; parentToolCallId: string; index: number; assignmentId: string; sessionId?: string };
type Context = {
    cwd: string;
    sessionManager?: { getSessionId?: () => unknown; getSessionFile?: () => unknown };
    ui?: { notify?: (message: string, kind: "warning") => void };
};
type Host = {
    [key: symbol]: unknown;
    pi?: { VERSION?: unknown };
    events?: { on(channel: string, handler: (event: unknown) => void): () => void };
    on(name: string, handler: (event: Value, ctx: Context) => unknown): void;
};
const object = (value: unknown): Value => value !== null && typeof value === "object" ? value as Value : {};
const pendingTasks = new Map<string, { assignments: string[] }>();
const childBindings = new Map<string, TaskBinding>();
const stoppedTaskChildren = new Set<string>();
const activeParentSessions = new Map<string, boolean>();
const assignmentReference = (value: unknown): string | null => typeof value === "string" ? value.match(/^WR_NEXT_ASSIGNMENT=(del_[0-9a-f-]{36})(?:\\r?\\n|$)/i)?.[1] ?? null : null;
const taskAssignments = (input: unknown): string[] | null => {
    const root = object(input), tasks = Array.isArray(root.tasks) ? root.tasks : [root];
    if (tasks.length === 0 || tasks.length > 32) return null;
    const assignments = tasks.map(task => assignmentReference(object(task).task));
    return assignments.every((assignment): assignment is string => assignment !== null) ? assignments : null;
};

export default function wrNext(pi: Host): void {
    // The host API instance changes on reload. Do not retain a process-global loaded flag.
    const key = Symbol.for("wr-next:omp:v1");
    if (pi[key]) return;
    pi[key] = true;
    const version = pi.pi?.VERSION;
    const nativeTaskBindingSupported = version === "18.1.13" || version === "v18.1.13";
    let guidance = "", sessionId = "", child: TaskBinding | null = null, unboundTaskChild = false, inactiveTaskChild = false, coordinatorActive = false, rootContext: Context | null = null;
    async function dispatch(event: Value, ctx: Context, sessionOverride?: string): Promise<Value> {
        if (process.env.WR_NEXT_RUNTIME_KIND && process.env.WR_NEXT_RUNTIME_KIND !== "omp") return {};
        const session = sessionOverride ?? ctx.sessionManager?.getSessionId?.();
        if (typeof session !== "string" || !session) throw new Error("wr-next: OMP session identity unavailable");
        const { promise, resolve, reject } = Promise.withResolvers<Value>();
        const childProcess = spawn("wr-next", ["internal", "integration-event", "--source", "omp", "--adapter-version", "1", "--installation", "project", "--event", String(event.hook_event_name)], {
            cwd: ctx.cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"],
        });
        let output = "", errors = "", settled = false;
        const finish = (error?: Error, value?: Value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value ?? {}); };
        const timer = setTimeout(() => { childProcess.kill(); finish(new Error("wr-next: integration timeout")); }, 18000);
        childProcess.on("error", error => finish(error instanceof Error ? error : new Error(String(error))));
        childProcess.stdin.on("error", error => finish(error instanceof Error ? error : new Error(String(error))));
        childProcess.stdout.on("data", chunk => { output += String(chunk); if (output.length > 131072) { childProcess.kill(); finish(new Error("wr-next: oversized hook response")); } });
        childProcess.stderr.on("data", chunk => { errors = (errors + String(chunk)).slice(-4096); });
        childProcess.on("close", code => {
            if (code !== 0) return finish(new Error(errors || "wr-next: hook failed"));
            try { finish(undefined, object(output.trim() ? JSON.parse(output) : {})); } catch { finish(new Error("wr-next: malformed hook response")); }
        });
        childProcess.stdin.end(JSON.stringify({ ...event, session_id: session, cwd: ctx.cwd }));
        return await promise;
    }
    const warn = (ctx: Context, error: unknown) => ctx.ui?.notify?.(String(error), "warning");
    pi.events?.on("task:subagent:lifecycle", async event => {
        if (!nativeTaskBindingSupported || !coordinatorActive) return;
        const lifecycle = object(event);
        if (typeof lifecycle.parentToolCallId !== "string" || typeof lifecycle.index !== "number" || !Number.isInteger(lifecycle.index) || typeof lifecycle.id !== "string" || typeof lifecycle.sessionFile !== "string" || !sessionId) return;
        if (lifecycle.status === "started") {
            const assignments = pendingTasks.get(sessionId + "\\u0000" + lifecycle.parentToolCallId)?.assignments;
            const assignmentId = assignments?.[lifecycle.index];
            if (!assignmentId) return;
            childBindings.set(lifecycle.sessionFile, { agentId: lifecycle.id, parentSessionId: sessionId, parentToolCallId: lifecycle.parentToolCallId, index: lifecycle.index, assignmentId });
            return;
        }
        if (!["completed", "failed", "aborted"].includes(String(lifecycle.status))) return;
        const binding = childBindings.get(lifecycle.sessionFile), context = rootContext;
        if (!binding || binding.parentSessionId !== sessionId || binding.parentToolCallId !== lifecycle.parentToolCallId || binding.index !== lifecycle.index || binding.agentId !== lifecycle.id || !binding.sessionId || !context || stoppedTaskChildren.has(lifecycle.sessionFile)) return;
        try {
            await dispatch({ hook_event_name: "SubagentStop", agent_id: binding.agentId, parent_session_id: binding.parentSessionId, parent_tool_call_id: binding.parentToolCallId, child_index: binding.index, assignment_id: binding.assignmentId, terminal_status: lifecycle.status }, context, binding.sessionId);
            stoppedTaskChildren.add(lifecycle.sessionFile);
        }
        catch (error) { warn(context, error); }
    });
    pi.on("session_start", async (_event, ctx) => {
        const session = ctx.sessionManager?.getSessionId?.();
        if (typeof session !== "string" || !session) {
            warn(ctx, "wr-next: OMP session identity unavailable");
            return;
        }
        sessionId = session;
        const file = ctx.sessionManager?.getSessionFile?.();
        child = typeof file === "string" ? childBindings.get(file) ?? null : null;
        if (child) child.sessionId = session;
        const parentFile = typeof file === "string" && file.endsWith(".jsonl") && existsSync(dirname(file) + ".jsonl") ? dirname(file) + ".jsonl" : null;
        inactiveTaskChild = !child && parentFile !== null && activeParentSessions.get(parentFile) === false;
        unboundTaskChild = !child && parentFile !== null && !inactiveTaskChild;
        if (inactiveTaskChild || unboundTaskChild) {
            if (unboundTaskChild)
                guidance = "wr-next: this OMP task child lacks a verified native lifecycle binding; its tools are blocked rather than inheriting root Coordinator state.";
            return;
        }
        if (!child) rootContext = ctx;
        try {
            const event = child
                ? { hook_event_name: "SubagentStart", agent_id: child.agentId, parent_session_id: child.parentSessionId, parent_tool_call_id: child.parentToolCallId, child_index: child.index, assignment_id: child.assignmentId }
                : { hook_event_name: "SessionStart", source: "startup" };
            const decision = object((await dispatch(event, ctx)).hookSpecificOutput);
            if (!child) {
                coordinatorActive = decision.wrNextActive === true;
                if (typeof file === "string") activeParentSessions.set(file, coordinatorActive);
            }
            guidance = typeof decision.additionalContext === "string" ? decision.additionalContext : "";
        }
        catch (error) { warn(ctx, error); }
    });
    pi.on("session_compact", async (event, ctx) => {
        if (inactiveTaskChild || unboundTaskChild || child) return;
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
        if (inactiveTaskChild) return;
        if (unboundTaskChild) return { block: true, reason: "wr-next: OMP task child lacks a verified lifecycle binding" };
        if ((child || coordinatorActive) && event.toolName === "task" && !nativeTaskBindingSupported)
            return { block: true, reason: "wr-next: native OMP task binding is verified only for OMP 18.1.13" };
        const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : null;
        if (!toolCallId) return { block: true, reason: "wr-next: OMP tool identity unavailable" };
        const assignments = !child && coordinatorActive && event.toolName === "task" ? taskAssignments(event.input) : null;
        try {
            const result = await dispatch({ hook_event_name: "PreToolUse", tool_name: event.toolName, tool_input: event.input, tool_use_id: toolCallId,
                ...(child ? { agent_id: child.agentId, parent_session_id: child.parentSessionId, parent_tool_call_id: child.parentToolCallId, child_index: child.index, assignment_id: child.assignmentId } : {}) }, ctx);
            const decision = object(result.hookSpecificOutput);
            if (decision.permissionDecision === "deny") return { block: true, reason: String(decision.permissionDecisionReason ?? "wr-next denied the tool") };
            if (assignments) pendingTasks.set(sessionId + "\\u0000" + toolCallId, { assignments });
            if (decision.updatedInput !== undefined) return { input: object(decision.updatedInput) };
        } catch (error) { return { block: true, reason: String(error) }; }
    });
    pi.on("tool_result", async (event, ctx) => {
        if (inactiveTaskChild || unboundTaskChild) return;
        const content = Array.isArray(event.content) ? event.content.map(object) : [];
        try { await dispatch({ hook_event_name: event.isError ? "PostToolUseFailure" : "PostToolUse", tool_name: event.toolName, tool_input: event.input, tool_use_id: event.toolCallId,
            tool_response: { is_error: event.isError, output: content.filter(item => item.type === "text").map(item => String(item.text ?? "")).join("\\n") },
            ...(child ? { agent_id: child.agentId, parent_session_id: child.parentSessionId, parent_tool_call_id: child.parentToolCallId, child_index: child.index, assignment_id: child.assignmentId } : {}) }, ctx); }
        catch (error) { warn(ctx, error); }
    });
    pi.on("session_shutdown", async (_event, ctx) => {
        if (inactiveTaskChild || unboundTaskChild) return;
        const file = ctx.sessionManager?.getSessionFile?.();
        if (child && typeof file === "string" && stoppedTaskChildren.has(file)) return;
        try {
            await dispatch(child
                ? { hook_event_name: "SubagentStop", agent_id: child.agentId, parent_session_id: child.parentSessionId, parent_tool_call_id: child.parentToolCallId, child_index: child.index, assignment_id: child.assignmentId }
                : { hook_event_name: "SessionEnd" }, ctx);
            if (child && typeof file === "string") stoppedTaskChildren.add(file);
        }
        catch (error) { warn(ctx, error); }
        if (!child && sessionId) {
            for (const task of pendingTasks.keys())
                if (task.startsWith(sessionId + "\\u0000"))
                    pendingTasks.delete(task);
        }
        // Session shutdown is advisory. A supervised launcher owns definitive OS termination.
    });
}
`;
}
