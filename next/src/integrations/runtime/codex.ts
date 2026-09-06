import { commandHookAdapter } from "./contract.js";
/** codex project profile. Native work assignment still requires a trusted dispatcher. */
export const codexAdapter = commandHookAdapter("codex", ["spawn_agent", "Agent", "send_input", "resume_agent", "close_agent"]);
