/**
 * Claude hooks expose agent_id for subagent tool calls, but SubagentStart alone
 * does not establish which WorkItem was delegated. Never guess that association.
 * This wrapper adapter is deliberately guarded, not a full native tool dispatcher.
 */
export function claudeChildGuard(payload: {
    hook_event_name?: string;
    agent_id?: unknown;
    tool_name?: string;
}): Record<string, unknown> | null {
    const child = typeof payload.agent_id === "string" && payload.agent_id.length > 0;
    const nativeSpawn = payload.hook_event_name === "PreToolUse" && ["Agent", "Task"].includes(payload.tool_name ?? "");
    if (!child && !nativeSpawn)
        return null;
    const message = "wr-next: native child has no verified per-tool work binding. Do not use the inherited parent context. A trusted runtime dispatcher must bind this child, or use an explicitly delegated wr-next run.";
    if (payload.hook_event_name === "PreToolUse")
        return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: message } };
    if (payload.hook_event_name === "SubagentStart")
        return { hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext: message } };
    // A native Stop is not OS termination; PostToolUse must not attribute child
    // activity to the parent's publisher/committer identity.
    return {};
}
