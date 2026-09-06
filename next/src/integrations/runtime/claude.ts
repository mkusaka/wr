import { commandHookAdapter } from "./contract.js";
/** claude project profile. Native work assignment still requires a trusted dispatcher. */
export const claudeAdapter = commandHookAdapter("claude", ["Agent", "Task", "SendMessage"]);
