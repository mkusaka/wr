import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";
import { ompAdapter } from "./omp.js";
import type { HookRuntime } from "../runtime-config/catalog.js";
import type { RuntimeAdapter } from "./contract.js";
const adapters: Record<HookRuntime, RuntimeAdapter> = { claude: claudeAdapter, codex: codexAdapter, omp: ompAdapter };
export const runtimeAdapter = (runtime: HookRuntime): RuntimeAdapter => adapters[runtime];
