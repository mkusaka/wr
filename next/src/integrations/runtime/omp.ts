import { commandHookAdapter } from "./contract.js";
/** OMP project profile. Native task binding is supplied only by the version-gated project extension. */
export const ompAdapter = commandHookAdapter("omp", ["task", "Task", "Agent", "spawn_agent"]);
