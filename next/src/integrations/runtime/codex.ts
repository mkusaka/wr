import { commandHookAdapter } from "./contract.js";
/** Codex MAv1 read-only profile; unbound and unsupported native controls cannot inherit root context. */
export const codexAdapter = commandHookAdapter("codex", [
    "spawn_agent", "Agent", "multi_agent_v1spawn_agent",
    "send_input", "wait_agent", "wait", "resume_agent", "close_agent",
    "multi_agent_v1send_input", "multi_agent_v1wait_agent", "multi_agent_v1resume_agent", "multi_agent_v1close_agent",
    "collaborationspawn_agent", "collaborationsend_input", "collaborationwait_agent", "collaborationresume_agent", "collaborationclose_agent",
]);
