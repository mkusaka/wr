import type { Coordinator, CoordinationGrant, Principal, State, Work, WorkDispatch } from "./model.js";
import { demand, digest, equal, now, uid, values } from "./util.js";
import { descendants, dependencyBasis, emit, findWork, reasons, requireOperator } from "./work.js";
import { flag, list, text, type ObjectValue } from "../protocol/validate.js";
type Invoke = (s: State, p: Principal, c: ObjectValue & {
    type: string;
}) => any;
export const coordinationIntent = (w: Work) => digest({ title: w.title, description: w.description, policy: w.policy, resources: w.resources, lane: w.lane });
export function grantFor(s: State, p: Principal, id = p.grant): CoordinationGrant {
    const g = id ? s.coordinationGrants[id] : undefined;
    demand(g && g.owner === p.id && g.device === p.device && g.state === "enabled", "COORDINATION_REVOKED", "Repository coordination is not authorized for this principal/device", 403);
    return g;
}
export function coordinatorFor(s: State, p: Principal, active = true): Coordinator {
    const co = p.coordinator ? s.coordinators[p.coordinator] : undefined;
    demand(co && co.owner === p.id && co.device === p.device, "UNBOUND_COORDINATOR", "An explicit runtime coordinator binding is required", 403);
    const g = grantFor(s, p, co.grant);
    demand(co.grantGeneration === g.generation && p.generation === co.generation, "COORDINATION_REVOKED", "Coordinator generation is revoked", 403);
    if (active) {
        demand(co.state === "active" && s.runs[co.run]?.state === "active", "COORDINATOR_INACTIVE", "Coordinator is closed or uncertain", 409);
        demand(s.work[co.work]?.state !== "cancelled" && co.intent === coordinationIntent(s.work[co.work]!), "STALE_SCOPE", "Repository purpose or policy changed; explicitly rebind after reviewing it");
        assertScope(s, co, co.work);
    }
    return co;
}
/** Closing a known invocation is allowed after grant revocation, but cannot refresh work credentials. */
export function coordinatorObserver(s: State, p: Principal): Coordinator {
    const co = p.coordinator ? s.coordinators[p.coordinator] : undefined;
    demand(p.role === "coordination-runtime" && co && co.owner === p.id && co.device === p.device && co.generation === p.generation, "UNBOUND_COORDINATOR", "Original lifecycle controller required", 403);
    return co;
}
export function assertScope(s: State, co: Pick<Coordinator, "work">, id: string, root = true): void {
    demand((root || id !== co.work) && descendants(s, co.work).has(id), "FORBIDDEN", "Work is outside the authorized repository scope", 403);
    for (const source of values(s.sources))
        demand(source.mode === "next" || !descendants(s, source.root).has(id), "READ_ONLY_SHADOW", "Imported work is not active authority");
}
export function dispatchFor(s: State, p: Principal, co: Coordinator, active = true): WorkDispatch {
    const d = p.dispatch ? s.dispatches[p.dispatch] : undefined;
    demand(d && d.coordinator === co.id && (!active || d.state === "open"), "STALE_DISPATCH", "A live tool-scoped binding is required", 409);
    return d;
}
export function assertCoordinatorWrite(s: State, p: Principal): Coordinator {
    const co = coordinatorFor(s, p);
    dispatchFor(s, p, co);
    demand(s.work[co.work]?.state === "open", "REPLAN_REQUIRED", "Completed coordination scope must be reopened explicitly");
    return co;
}
/** Current candidate calculation is shared by dry queries and atomic claim. */
export function readyCandidates(s: State, co: Pick<Coordinator, "id" | "work" | "environment">, options: {
    retry?: boolean;
    limit?: number;
} = {}) {
    const allowed = descendants(s, co.work);
    const ownReservations = values(s.reservations).filter(r => r.coordinator === co.id);
    const view = { ...s, reservations: Object.fromEntries(values(s.reservations).filter(r => !ownReservations.includes(r)).map(r => [r.id, r])) };
    const ready: {
        id: string;
        key: string;
        title: string;
        priority: number;
        scopeRevision: number;
        reason: string[];
    }[] = [];
    const blocked: {
        id: string;
        key: string;
        title: string;
        reasons: string[];
    }[] = [];
    for (const w of values(s.work).filter(w => allowed.has(w.id) && w.id !== co.work && w.state === "open" && w.policy.name !== "children-v1" && !values(s.work).some(x => x.parent === w.id))) {
        const why = reasons(view, w, co.environment);
        for (let parent = w.parent ? s.work[w.parent] : undefined; parent; parent = parent.parent ? s.work[parent.parent] : undefined) {
            if (parent.state === "cancelled")
                why.push("ancestor_cancelled");
            if (values(s.holds).some(h => h.work === parent!.id && !h.resolvedAt))
                why.push("ancestor_held");
        }
        if (values(s.sources).some(source => source.mode !== "next" && descendants(s, source.root).has(w.id)))
            why.push("read_only_shadow");
        const last = values(s.results).filter(r => r.work === w.id).at(-1);
        if (!options.retry && !last && values(s.executions).some(e => e.work === w.id && e.scopeRevision === w.scopeRevision && ["failed", "interrupted"].includes(e.state)))
            why.push("retry_required");
        if (!options.retry && last && last.scopeRevision === w.scopeRevision && equal(last.basis, dependencyBasis(s, w)) && (!w.candidate || equal(last.manifest, w.candidate)))
            why.push("submitted_waiting_checks");
        if (why.length)
            blocked.push({ id: w.id, key: w.key, title: w.title, reasons: [...new Set(why)] });
        else
            ready.push({ id: w.id, key: w.key, title: w.title, priority: w.priority, scopeRevision: w.scopeRevision, reason: ["dependencies_satisfied", "resources_available"] });
    }
    ready.sort((a, b) => b.priority - a.priority || Number(a.key.slice(1)) - Number(b.key.slice(1)) || a.id.localeCompare(b.id));
    return { ready: ready.slice(0, options.limit ?? 20), total: ready.length, hasMore: ready.length > (options.limit ?? 20), blocked: blocked.slice(0, options.limit ?? 20), blockedTotal: blocked.length };
}
function finishReleased(s: State, co: Coordinator): void {
    const e = co.currentExecution ? s.executions[co.currentExecution] : undefined;
    if (!e)
        return;
    if (values(s.dispatches).some(d => d.coordinator === co.id && d.execution === e.id && d.state === "open"))
        return;
    if (!values(s.dispatches).some(d => d.coordinator === co.id && d.execution === e.id && d.releaseRequested))
        return;
    e.state = values(s.results).some(r => r.execution === e.id) ? "finished" : "interrupted";
    e.endedAt = now();
    // Work attempt completion is NOT process termination. Keep the environment lease.
    for (const r of values(s.reservations))
        if (r.execution === e.id && !r.coordinator)
            r.state = "released";
    co.currentExecution = null;
    s.runtimeAgents[co.runtimeAgent]!.execution = null;
}
export function coordinatorCommand(s: State, p: Principal, c: ObjectValue & {
    type: string;
}, invoke: Invoke): unknown {
    if (c.type === "coordination.enable") {
        requireOperator(p);
        const repository = text(c.repository, "repository", 2000), environment = text(c.environment, "environment", 2000);
        const runtimes = list(c.runtimes, x => text(x, "runtime", 80), 20);
        demand(runtimes.length > 0, "INVALID_INPUT", "At least one runtime is required", 400);
        const id = digest({ repository, device: p.device, owner: p.id });
        const old = s.coordinationGrants[id];
        if (old) {
            if (c.checks !== undefined) {
                const checks = [...new Set(list(c.checks, x => text(x, "check", 120), 30))].sort();
                demand(equal(checks, old.defaultPolicy.checks), "POLICY_REPLAN_REQUIRED", "Re-enrollment cannot silently change completion policy. Replan affected work explicitly");
            }
            if (old.state !== "enabled") {
                old.state = "enabled";
                old.generation++;
            }
            demand(c.work === undefined || findWork(s, text(c.work, "work")).id === old.work, "SCOPE_CONFLICT", "Existing repository registration has a different scope");
            if (!old.environments.includes(environment))
                old.environments.push(environment);
            old.runtimes = [...new Set([...old.runtimes, ...runtimes])];
            return { grant: old.id, work: old.work, generation: old.generation };
        }
        const siblings = values(s.coordinationGrants).filter(x => x.repository === repository);
        const roots = [...new Set(siblings.map(x => x.work))];
        demand(c.work !== undefined || roots.length <= 1, "AMBIGUOUS_SCOPE", "Repository has multiple registered scopes; choose one explicitly");
        let root: Work;
        if (c.work === undefined && roots[0])
            root = findWork(s, roots[0]);
        else if (c.work === undefined) {
            const created = invoke(s, p, { type: "work.create", title: text(c.title, "title", 200), policy: { name: "children-v1", checks: [] } });
            root = s.work[created.id]!;
            root.collection = true;
        }
        else
            root = findWork(s, text(c.work, "work"));
        demand(!root.parent && root.state === "open" && root.policy.name !== "evidence-v1", "INVALID_SCOPE", "Repository coordination requires an open top-level aggregate scope");
        const inherited = siblings.find(x => x.work === root.id)?.defaultPolicy.checks ?? [];
        const checks = [...new Set(list(c.checks ?? inherited, x => text(x, "check", 120), 30))].sort();
        demand(siblings.filter(x => x.work === root.id).every(x => equal(x.defaultPolicy.checks, checks)), "POLICY_REPLAN_REQUIRED", "All devices sharing a repository scope must preserve its leaf policy");
        s.coordinationGrants[id] = { id, repository, work: root.id, owner: p.id, device: p.device, environments: [environment], runtimes, generation: 1, state: "enabled", defaultPolicy: checks.length ? { name: "evidence-v1", checks } : { name: "declaration-v1", checks: [] }, maxItems: 1000 };
        emit(s, p, c.type, { grant: id, repository, scope: root.id }, root.id);
        return { grant: id, work: root.id, generation: 1 };
    }
    if (c.type === "coordination.revoke") {
        requireOperator(p);
        const g = grantFor(s, p, text(c.grant, "grant"));
        g.state = "revoked";
        g.generation++;
        emit(s, p, c.type, { grant: g.id, reason: text(c.reason, "reason") }, g.work);
        return { grant: g.id, state: g.state };
    }
    if (c.type === "coordination.open") {
        demand(p.role === "bootstrap", "FORBIDDEN", "Repository bootstrap capability required", 403);
        const g = grantFor(s, p);
        demand(p.generation === g.generation, "COORDINATION_REVOKED", "Bootstrap grant has changed", 403);
        const runtime = text(c.runtime, "runtime", 80), environment = text(c.environment, "environment", 2000);
        demand(g.runtimes.includes(runtime) && g.environments.includes(environment), "FORBIDDEN", "Runtime or checkout is outside the operator-approved registration", 403);
        const sessionId = text(c.session, "session", 300), actor = text(c.actor, "actor", 300), invocation = text(c.invocation, "invocation", 300);
        const id = digest({ grant: g.id, runtime, sessionId, actor, invocation });
        const old = s.coordinators[id];
        if (old) {
            coordinatorFor(s, { ...p, coordinator: id, generation: old.generation });
            return { coordinator: id, runtimeAgent: old.runtimeAgent, run: old.run, work: old.work };
        }
        const session = values(s.sessions).find(x => x.device === p.device && x.runtime === runtime && x.externalId === sessionId)?.id ?? digest({ device: p.device, runtime, externalId: sessionId });
        s.sessions[session] ??= { id: session, runtime, externalId: sessionId, device: p.device };
        const run = uid("run"), agent = digest({ coordinator: id, actor, invocation });
        s.runs[run] = { id: run, session, device: p.device, runtime, runtimeAgent: agent, parentRun: null, state: "active", startedAt: now(), endedAt: null, windows: [], metadata: { binding: "coordinator" } };
        s.runtimeAgents[agent] = { id: agent, root: agent, parent: null, runtime, externalSessionId: sessionId, externalAgentId: actor, invocationId: invocation, device: p.device, run, execution: null, state: "active", generation: 1, startedAt: now(), endedAt: null };
        s.coordinators[id] = { id, grant: g.id, grantGeneration: g.generation, work: g.work, runtimeAgent: agent, run, device: p.device, owner: p.id, environment, generation: 1, scopeRevision: s.work[g.work]!.scopeRevision, intent: coordinationIntent(s.work[g.work]!), currentExecution: null, state: "active" };
        emit(s, p, c.type, { coordinator: id, runtimeAgent: agent, run }, g.work, "observed");
        return { coordinator: id, runtimeAgent: agent, run, work: g.work };
    }
    const co = c.type === "coordination.stop" || c.type === "coordination.dispatch.close" ? coordinatorObserver(s, p) : coordinatorFor(s, p);
    if (c.type === "coordination.dispatch") {
        demand(p.role === "coordination-runtime", "FORBIDDEN", "Trusted runtime dispatcher required", 403);
        const externalId = text(c.toolId, "toolId", 300), inputDigest = text(c.inputDigest, "inputDigest", 128);
        const id = digest({ coordinator: co.id, toolId: externalId });
        const old = s.dispatches[id];
        if (old) {
            demand(old.inputDigest === inputDigest && old.state === "open", "STALE_DISPATCH", "Tool already closed or reused with different input");
            return { coordinator: co.id, dispatch: id };
        }
        const e = co.currentExecution ? s.executions[co.currentExecution] : undefined;
        s.dispatches[id] = { id, coordinator: co.id, externalId, inputDigest, execution: e?.id ?? null, generation: e?.generation ?? null, state: "open", releaseRequested: false };
        return { coordinator: co.id, dispatch: id };
    }
    if (c.type === "coordination.dispatch.close") {
        demand(p.role === "coordination-runtime", "FORBIDDEN", "Trusted runtime dispatcher required", 403);
        const d = s.dispatches[text(c.dispatch, "dispatch")];
        demand(d?.coordinator === co.id, "FORBIDDEN", "Tool belongs to a different runtime", 403);
        d.state = "closed";
        finishReleased(s, co);
        return { coordinator: co.id, currentExecution: co.currentExecution };
    }
    if (c.type === "coordination.stop") {
        demand(p.role === "coordination-runtime", "FORBIDDEN", "Runtime lifecycle observer required", 403);
        co.state = "closed";
        // Advisory session end closes new work mutations, but never proves stopped writers.
        if (flag(c.processStopped)) {
            for (const e of values(s.executions).filter(e => e.run === co.run)) {
                if (e.state === "active") {
                    e.state = values(s.results).some(r => r.execution === e.id) ? "finished" : "interrupted";
                    e.endedAt = now();
                    e.generation++;
                }
                for (const r of values(s.reservations))
                    if (r.execution === e.id || r.coordinator === co.id)
                        r.state = "released";
            }
            s.runs[co.run]!.state = "ended";
            s.runs[co.run]!.endedAt = now();
            s.runtimeAgents[co.runtimeAgent]!.state = "ended";
            s.runtimeAgents[co.runtimeAgent]!.endedAt = now();
        }
        else if (s.runs[co.run]!.state !== "ended")
            s.runs[co.run]!.state = "unknown";
        emit(s, p, c.type, { coordinator: co.id, processStopped: flag(c.processStopped) }, co.work, "observed");
        return { coordinator: co.id, state: co.state };
    }
    if (c.type === "coordination.window") {
        demand(p.role === "coordination-runtime", "FORBIDDEN", "Runtime lifecycle observer required", 403);
        const id = text(c.window, "window", 200);
        if (!s.runs[co.run]!.windows.includes(id))
            s.runs[co.run]!.windows.push(id);
        return { coordinator: co.id, run: co.run };
    }
    if (c.type === "coordination.credentials") {
        demand(p.role === "coordinator", "FORBIDDEN", "Coordinator capability required", 403);
        dispatchFor(s, p, co);
        return { coordinator: co.id, dispatch: p.dispatch };
    }
    const d = dispatchFor(s, p, co);
    demand(p.role === "coordinator", "FORBIDDEN", "Coordinator tool capability required", 403);
    if (c.type === "coordination.note") {
        demand(c.kind === "decision" || c.kind === "progress", "INVALID_INPUT", "Root notes support decision or progress only", 400);
        const summary = text(c.summary, "summary");
        emit(s, p, `coordination.${c.kind}`, { summary, ...(c.reason ? { reason: text(c.reason, "reason") } : {}) }, co.work);
        return { coordinator: co.id, recorded: true };
    }
    if (c.type === "work.claim") {
        if (co.currentExecution) {
            demand(d.execution === co.currentExecution && (c.work === undefined || findWork(s, text(c.work, "work")).id === s.executions[co.currentExecution]!.work), "CURRENT_WORK_BUSY", "Finish or yield the current work at a tool boundary before selecting another");
            return { coordinator: co.id, dispatch: d.id, execution: co.currentExecution, claimed: false };
        }
        demand(!d.execution, "STALE_DISPATCH", "This tool was dispatched for a previous work item");
        demand(!values(s.dispatches).some(other => other.coordinator === co.id && other.id !== d.id && other.state === "open"), "TOOLS_IN_FLIGHT", "Selection requires a tool boundary; another tool is still active");
        const retry = flag(c.retry);
        if (retry)
            text(c.reason, "retry reason");
        const candidates = readyCandidates(s, co, { retry, limit: 5000 });
        let w: Work | undefined;
        if (c.work !== undefined) {
            w = findWork(s, text(c.work, "work"));
            assertScope(s, co, w.id, false);
            demand(candidates.ready.some(x => x.id === w!.id), "NOT_READY", "The selected work is not currently ready");
        }
        else if (candidates.ready[0])
            w = s.work[candidates.ready[0].id];
        if (!w)
            return { coordinator: co.id, dispatch: d.id, idle: true, reason: "no_ready_work" };
        const active = invoke(s, p, { type: "execution.start", work: w.id, environment: co.environment, runtime: s.runs[co.run]!.runtime, existingRun: co.run, launchId: d.id, role: "implementer", mode: "write" });
        const e = s.executions[active.execution]!;
        e.coordinator = co.id;
        co.currentExecution = e.id;
        s.runtimeAgents[co.runtimeAgent]!.execution = e.id;
        d.execution = e.id;
        d.generation = e.generation;
        // Keep exactly one physical environment lease for this actor across sequential work.
        const leases = values(s.reservations).filter(r => r.state === "active" && r.key === `environment:${co.environment}`);
        for (const lease of leases)
            lease.coordinator = co.id;
        emit(s, p, "work.claimed", { coordinator: co.id, execution: e.id, retry }, w.id);
        return { coordinator: co.id, dispatch: d.id, execution: e.id, claimed: true, work: w.id, key: w.key, title: w.title };
    }
    if (c.type === "work.yield") {
        demand(d.execution && d.execution === co.currentExecution, "NO_CURRENT_WORK", "No work assigned to this tool");
        text(c.reason, "reason");
        d.releaseRequested = true;
        emit(s, p, c.type, { coordinator: co.id, execution: d.execution, reason: c.reason }, s.executions[d.execution]!.work);
        return { coordinator: co.id, dispatch: d.id, pendingBoundary: true };
    }
    throw new Error(`Unknown coordinator operation ${c.type}`);
}
