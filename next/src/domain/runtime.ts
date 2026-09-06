import type { Execution, Principal, RuntimeAgent, State } from "./model.js";
import { demand, digest, equal, now, values } from "./util.js";
import { dependencyBasis, descendants, emit } from "./work.js";
/** Capability identity and generation are checked even on idempotent replays. */
export function boundExecution(s: State, p: Principal, active = false): Execution {
    const e = p.execution ? s.executions[p.execution] : undefined;
    demand(e && s.runs[e.run]?.device === p.device, "FORBIDDEN", "Execution is not bound to this device", 403);
    demand(p.generation === undefined || p.generation === e.generation, "FENCED_EXECUTION", "Capability generation was revoked", 403);
    if (p.runtimeAgent) {
        const agent = s.runtimeAgents[p.runtimeAgent];
        demand(agent?.execution === e.id && agent.run === e.run && agent.device === p.device, "UNBOUND_RUNTIME_ACTOR", "Runtime actor does not own this execution", 403);
        if (active)
            demand(agent.state !== "ended", "FENCED_EXECUTION", "Runtime actor has ended", 403);
    }
    if (active)
        demand(e.state === "active", "FENCED_EXECUTION", "Execution is no longer active");
    return e;
}
export function freshExecution(s: State, e: Execution): void {
    const w = s.work[e.work];
    demand(w && w.state !== "cancelled" && e.scopeRevision === w.scopeRevision && equal(e.basis, dependencyBasis(s, w)), "STALE_SCOPE", "Execution requirements or prerequisites changed");
}
export function requirePlanner(s: State, p: Principal): Execution {
    demand(p.role === "worker", "FORBIDDEN", "Scoped worker planning permission required", 403);
    const e = boundExecution(s, p, true);
    demand(e.role === "orchestrator" && e.mode === "read", "FORBIDDEN", "Only read-only orchestrators may plan within their scope", 403);
    freshExecution(s, e);
    demand(s.work[e.work]!.state === "open" && !s.work[e.work]!.acceptance, "REPLAN_REQUIRED", "An operator must reopen completed planning scope");
    for (const source of values(s.sources))
        demand(source.mode === "next" || !descendants(s, source.root).has(e.work), "READ_ONLY_SHADOW", "Imported scope is not the active authority");
    return e;
}
export function inPlanningScope(s: State, e: Execution, work: string, includeRoot = false): void {
    demand((includeRoot || work !== e.work) && descendants(s, e.work).has(work), "FORBIDDEN", "Work is outside the assigned planning scope", 403);
}
export function requireUnattempted(s: State, work: string): void {
    demand(!values(s.executions).some(e => e.work === work) && !values(s.results).some(r => r.work === work) && !s.work[work]?.acceptance && s.work[work]?.state === "open", "REPLAN_REQUIRED", "An operator must replan attempted, completed or cancelled work");
}
/** Identity includes invocation: a resumed/reused native ID cannot revive an old attempt. */
export function agentKey(root: string, session: string, agent: string, invocation: string): string {
    return digest({ root, session, agent, invocation });
}
export function adapterAgent(s: State, p: Principal, id: string): RuntimeAgent {
    demand(p.role === "adapter" && p.runtimeRoot, "UNAUTHORIZED_OBSERVATION", "Runtime adapter capability required", 403);
    const root = s.runtimeAgents[p.runtimeRoot], agent = s.runtimeAgents[id];
    demand(root && agent && agent.root === root.id && agent.device === p.device && root.device === p.device, "FORBIDDEN", "Runtime actor is outside this adapter root", 403);
    demand(p.generation === root.generation, "FENCED_EXECUTION", "Runtime adapter generation was revoked", 403);
    return agent;
}
export function sessionFor(s: State, runtime: string, externalId: string, device: string, parentSession: string | null = null): string {
    // Older execution.start used `external`, while runtime.event used `externalId`.
    // Reuse either historical row without overwriting the identity of an existing Run.
    const existing = values(s.sessions).find(x => x.runtime === runtime && x.externalId === externalId && x.device === device);
    if (existing)
        return existing.id;
    const id = digest({ runtime, externalId, device });
    s.sessions[id] = { id, runtime, externalId, device, parentSession: parentSession === id ? null : parentSession };
    return id;
}
export function executionView(s: State, execution: string, runtimeAgent?: string) {
    const e = s.executions[execution]!, w = s.work[e.work]!;
    return { execution: e.id, run: e.run, work: w.id, key: w.key, scopeRevision: e.scopeRevision, generation: e.generation, role: e.role, mode: e.mode, environment: e.environment, ...(runtimeAgent ? { runtimeAgent, runtimeRoot: s.runtimeAgents[runtimeAgent]!.root } : {}) };
}
export function endExecution(s: State, e: Execution, event: "ended" | "launch_failed", exit: number | null): void {
    if (e.state !== "active")
        return;
    e.state = event === "launch_failed" || exit !== 0 ? "failed" : values(s.results).some(r => r.execution === e.id) ? "finished" : "interrupted";
    e.endedAt = now();
    for (const reservation of values(s.reservations))
        if (reservation.execution === e.id)
            reservation.state = "released";
}
/** Parent termination does not terminate children or release their reservations. */
export function lifecycle(s: State, p: Principal, agent: RuntimeAgent, event: string, exit: number | null, window?: string, sequence?: number): void {
    const run = s.runs[agent.run]!;
    if (sequence !== undefined && agent.lastSequence !== undefined && sequence <= agent.lastSequence) {
        emit(s, p, "runtime.late_event", { agent: agent.id, event, sequence }, agent.execution ? s.executions[agent.execution]!.work : null, "observed");
        return;
    }
    if (sequence !== undefined)
        agent.lastSequence = sequence;
    if (agent.state === "ended") {
        // Late start/heartbeat/window/stop observations cannot resurrect an actor.
        emit(s, p, "runtime.late_event", { agent: agent.id, event }, agent.execution ? s.executions[agent.execution]!.work : null, "observed");
        return;
    }
    if (event === "quiescent") {
        // A native Stop hook means the model stopped responding, not that tools/processes exited.
        agent.state = "quiescent";
    }
    else if (event === "unknown") {
        agent.state = "unknown";
        run.state = "unknown";
    }
    else if (event === "ended") {
        agent.state = "ended";
        agent.endedAt = now();
        for (const execution of values(s.executions).filter(e => e.run === run.id))
            endExecution(s, execution, "ended", exit);
        run.state = "ended";
        run.endedAt = now();
    }
    else {
        agent.state = "active";
        run.state = "active";
        if (event === "window" && window && !run.windows.includes(window))
            run.windows.push(window);
    }
    emit(s, p, `runtime.agent.${event}`, { agent: agent.id, parent: agent.parent, run: run.id, window, exitCode: exit }, agent.execution ? s.executions[agent.execution]!.work : null, "observed");
}
