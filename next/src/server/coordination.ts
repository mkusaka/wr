import type { Principal, State } from "../domain/model.js";
import { demand } from "../domain/util.js";
import { coordinatorFor, grantFor } from "../domain/coordination.js";
import { executionView, freshExecution } from "../domain/runtime.js";
import type { Tokens } from "./auth.js";
/** Mint after transaction, rechecking the live binding even for cached commands. */
export function coordinationCredentials(s: State, p: Principal, type: string, output: {
    result: Record<string, unknown>;
}, tokens: Tokens): unknown | null {
    if (type === "coordination.enable") {
        const g = grantFor(s, p, output.result.grant as string);
        return { ...output, bootstrap: tokens.mint({ id: p.id, device: p.device, role: "bootstrap", grant: g.id, generation: g.generation }, 30 * 86400) };
    }
    if (!["coordination.open", "coordination.dispatch", "coordination.credentials", "work.claim"].includes(type))
        return null;
    const id = output.result.coordinator as string;
    const found = s.coordinators[id];
    demand(found, "UNBOUND_COORDINATOR", "Coordinator not found", 403);
    const co = coordinatorFor(s, { ...p, coordinator: id, generation: found.generation });
    const base = { id: p.id, device: p.device, coordinator: co.id, generation: co.generation };
    if (type === "coordination.open")
        return {
            ...output,
            capabilities: {
                coordinator: tokens.mint({ ...base, role: "coordinator" }),
                runtime: tokens.mint({ ...base, role: "coordination-runtime" }),
                adapter: tokens.mint({ id: p.id, device: p.device, role: "adapter", runtimeRoot: co.runtimeAgent, generation: s.runtimeAgents[co.runtimeAgent]!.generation }),
            },
        };
    const d = s.dispatches[output.result.dispatch as string];
    demand(d && d.coordinator === co.id && d.state === "open", "STALE_DISPATCH", "Cannot refresh a closed tool binding");
    const capabilities: Record<string, string> = { coordinator: tokens.mint({ ...base, role: "coordinator", dispatch: d.id }) };
    let binding = null;
    if (d.execution) {
        const e = s.executions[d.execution];
        demand(e && e.state === "active" && e.generation === d.generation && e.id === co.currentExecution, "STALE_DISPATCH", "Tool's execution is no longer active");
        freshExecution(s, e);
        binding = executionView(s, e.id, co.runtimeAgent);
        const worker = { id: p.id, device: p.device, execution: e.id, generation: e.generation, runtimeAgent: co.runtimeAgent, coordinator: co.id, dispatch: d.id };
        capabilities.worker = tokens.mint({ ...worker, role: "worker" });
        capabilities.effect = tokens.mint({ ...worker, role: "effect" });
        capabilities.git = tokens.mint({ ...worker, role: "collector", checks: ["git:*"] });
        capabilities.github = tokens.mint({ ...worker, role: "collector", checks: ["github:*"] });
    }
    return { ...output, binding, capabilities };
}
