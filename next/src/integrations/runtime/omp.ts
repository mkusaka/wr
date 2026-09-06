import { commandHookAdapter } from "./contract.js";
/** omp project profile. Native work assignment still requires a trusted dispatcher. */
export const ompAdapter = commandHookAdapter("omp", ["task", "Task", "Agent", "spawn_agent"]);
