import { claudeAdapter } from "../integrations/runtime/claude.js";
/** Compatibility shim; provider guards now live outside the generic runtime binder. */
export function claudeChildGuard(payload: {
    hook_event_name?: string;
    agent_id?: unknown;
    tool_name?: string;
}): Record<string, unknown> | null {
    const event = claudeAdapter.decode(JSON.stringify(payload)), decision = claudeAdapter.guard(event);
    return decision ? claudeAdapter.render(event, decision) : null;
}
