import type { State, Principal, Policy, Work, Execution, Resource, RuntimeAgent } from "./model.js";
import { demand, uid, now, digest, equal, values, manifest, Fault } from "./util.js";
import { Store } from "../server/store.js";
import { text, optionalText, object, list, choice, integer, flag, refs, command as validateCommand, type Envelope, type ObjectValue } from "../protocol/validate.js";
import { findWork, emit, order, descendants, dependencyBasis, reasons, reconcile, subject, requireOperator } from "./work.js";
import { applyObservation } from "./observations.js";
import { boundExecution, freshExecution, requirePlanner, inPlanningScope, requireUnattempted, agentKey, adapterAgent, sessionFor, executionView, lifecycle } from "./runtime.js";
function policy(value: unknown): Policy {
    if (value === undefined)
        return { name: "declaration-v1", checks: [] };
    const x = object(value, ["name", "checks"]);
    const name = choice(x.name, ["declaration-v1", "children-v1", "evidence-v1"] as const);
    const checks = list(x.checks ?? [], x => text(x, "check name", 120));
    demand(name !== "evidence-v1" || checks.length > 0, "UNSUPPORTED_POLICY", "Evidence policy needs at least one check");
    demand(name === "evidence-v1" || checks.length === 0, "UNSUPPORTED_POLICY", "Only evidence policy accepts checks");
    return { name, checks: [...new Set(checks)] };
}
function resources(x: unknown): Resource[] { return list(x ?? [], x => { const r = object(x, ["key", "mode"]); return { key: text(r.key, "resource", 1000), mode: choice(r.mode, ["read", "write", "exclusive"] as const) }; }); }
function target(s: State, p: Principal, key: unknown): {
    w: Work;
    e: Execution | null;
} {
    const e = p.role !== "operator" ? boundExecution(s, p, true) : p.execution ? s.executions[p.execution] : undefined;
    const w = findWork(s, key === undefined ? e?.work ?? "" : text(key, "work"));
    if (p.role !== "operator") {
        demand(e!.work === w.id, "AMBIGUOUS_CONTEXT", "Explicit work conflicts with bound context", 403);
        demand(e!.state === "active", "FENCED_EXECUTION", "Execution is no longer active", 409);
    }
    return { w, e: e ?? null };
}
function currentScope(w: Work, e: Execution | null, s: State): void {
    if (e)
        demand(e.scopeRevision === w.scopeRevision && equal(e.basis, dependencyBasis(s, w)), "STALE_SCOPE", "Requirements or dependencies changed; restart with current scope");
}
function touch(w: Work, scope = true): void {
    w.revision++;
    if (scope)
        w.scopeRevision++;
    w.updatedAt = now();
}
export class Workspace {
    constructor(readonly store: Store) { }
    execute(envelope: Envelope, p: Principal, observed = false): unknown {
        return this.store.sql.transaction(() => {
            const before = this.store.load();
            demand(!before.devices[p.device] || before.devices[p.device]!.owner === p.id, "FORBIDDEN", "Device belongs to another principal", 403);
            if (p.execution && p.role !== "operator" && p.role !== "adapter")
                boundExecution(before, p);
            if (p.role === "adapter")
                adapterAgent(before, p, p.runtimeRoot ?? "");
            if (!observed) {
                demand(p.role !== "collector", "FORBIDDEN", "Collectors cannot issue work commands", 403);
                if (p.role === "launcher")
                    demand(["execution.start", "delegation.issue", "runtime.attach", "effect.begin", "effect.resolve"].includes(envelope.command.type), "FORBIDDEN", "Launcher cannot issue worker or planning commands", 403);
                if (p.role === "adapter")
                    demand(["runtime.child", "runtime.bind", "runtime.credentials"].includes(envelope.command.type), "FORBIDDEN", "Adapter cannot issue work commands", 403);
            }
            const hash = digest({ command: envelope.command, expectedRevision: envelope.expectedRevision, observed, role: p.role, execution: p.execution, device: p.device, generation: p.generation, checks: p.checks, runtimeRoot: p.runtimeRoot, runtimeAgent: p.runtimeAgent });
            const previous = this.store.sql.all<{
                request_hash: string;
                result: string;
            }>("SELECT request_hash,result FROM operations WHERE principal=? AND id=?", p.id, envelope.operationId)[0];
            if (previous) {
                if (previous.request_hash !== hash) {
                    const legacyHash = digest({ command: envelope.command, expectedRevision: envelope.expectedRevision, observed, role: p.role, execution: p.execution });
                    demand(previous.request_hash !== legacyHash, "LEGACY_OPERATION_REPLAY", "Receipt predates device/generation binding. Inspect the previous result before explicitly retrying; do not create a new operation automatically");
                    throw new Fault("OPERATION_CONFLICT", "Operation ID reused with a different payload");
                }
                return JSON.parse(previous.result);
            }
            const s = structuredClone(before);
            demand(!s.devices[p.device] || s.devices[p.device]!.owner === p.id, "FORBIDDEN", "Device belongs to another principal", 403);
            s.devices[p.device] = { id: p.device, owner: p.id };
            if (envelope.expectedRevision !== undefined)
                demand(envelope.expectedRevision === s.meta.revision, "VERSION_CONFLICT", "Workspace changed since planning");
            let result: unknown;
            if (observed) {
                demand(p.role === "collector" || p.role === "launcher" || p.role === "adapter", "UNAUTHORIZED_OBSERVATION", "A collector capability is required", 403);
                if (envelope.command.type === "runtime.lifecycle") {
                    const c = envelope.command;
                    const agent = adapterAgent(s, p, text(c.agent, "agent"));
                    const event = choice(c.event, ["started", "heartbeat", "window", "quiescent", "unknown", "ended"] as const);
                    const exit = c.exitCode === undefined ? null : integer(c.exitCode, "exitCode", 0, 255);
                    lifecycle(s, p, agent, event, exit, event === "window" ? text(c.windowId, "windowId", 200) : undefined, c.sequence === undefined ? undefined : integer(c.sequence, "sequence", 0));
                    result = { agent: agent.id, state: agent.state };
                }
                else {
                    demand(p.role !== "adapter", "UNAUTHORIZED_OBSERVATION", "Adapter may only record runtime lifecycle", 403);
                    result = applyObservation(s, p, envelope.command);
                }
            }
            else
                result = this.command(s, p, envelope.command);
            if (envelope.command.type === "runtime.credentials") {
                const response = { operationId: envelope.operationId, revision: s.meta.revision, result };
                this.store.sql.execute("INSERT INTO operations VALUES(?,?,?,?)", p.id, envelope.operationId, hash, JSON.stringify(response));
                return response;
            }
            order(s);
            reconcile(s, p);
            s.meta.revision++;
            const response = { operationId: envelope.operationId, revision: s.meta.revision, result };
            this.store.save(before, s);
            this.store.sql.execute("INSERT INTO operations VALUES(?,?,?,?)", p.id, envelope.operationId, hash, JSON.stringify(response));
            return response;
        });
    }
    private command(s: State, p: Principal, c: ObjectValue & {
        type: string;
    }): unknown {
        const targetIds: unknown[] = [];
        if (["work.update", "work.cancel", "work.reopen", "work.report", "result.submit", "effect.prepare", "execution.start", "delegation.issue"].includes(c.type))
            targetIds.push(c.work ?? (p.execution ? s.executions[p.execution]?.work : undefined));
        if (c.type === "work.create" && c.parent)
            targetIds.push(c.parent);
        if (c.type.startsWith("dependency."))
            targetIds.push(c.dependent);
        if (c.type === "hold.resolve")
            targetIds.push(s.holds[String(c.hold)]?.work);
        for (const key of targetIds) {
            if (typeof key !== "string")
                continue;
            let w: Work | undefined = findWork(s, key);
            while (w) {
                const source = values(s.sources).find(source => source.root === w!.id);
                demand(!source || source.mode === "next", "READ_ONLY_SHADOW", "Imported scope is not the active authority");
                w = w.parent ? s.work[w.parent] : undefined;
            }
        }
        switch (c.type) {
            case "work.create": {
                const planner = p.role === "operator" ? null : requirePlanner(s, p);
                if (planner) {
                    c = { ...c, parent: c.parent ?? planner.work };
                    const parentId = findWork(s, text(c.parent, "parent")).id;
                    inPlanningScope(s, planner, parentId, true);
                    if (parentId !== planner.work)
                        requireUnattempted(s, parentId);
                    demand(!flag(c.replan), "FORBIDDEN", "Workers cannot authorize replanning", 403);
                    demand(c.policy === undefined && c.lane === undefined && c.resources === undefined, "FORBIDDEN", "Operator defines policies and resource budgets", 403);
                    for (const need of list(c.needs ?? [], x => text(x, "needs")))
                        inPlanningScope(s, planner, findWork(s, need).id);
                }
                demand(values(s.work).length < 5000, "WORKSPACE_LIMIT", "Split workspaces above 5000 work items");
                const parent = c.parent === undefined ? null : findWork(s, text(c.parent, "parent"));
                if (parent) {
                    // Decomposition must not be an indirect policy/budget escalation.
                    demand(parent.policy.name !== "evidence-v1" || p.role === "operator" && flag(c.replan), "REPLAN_REQUIRED", "An operator must explicitly replan evidence requirements before decomposition");
                    if (planner)
                        demand(parent.resources.length === 0, "REPLAN_REQUIRED", "Operator must define child resource inheritance before decomposing resource-bound work");
                    const ownDecomposition = planner?.work === parent.id;
                    demand(ownDecomposition || flag(c.replan) || !values(s.executions).some(e => e.work === parent.id) && !values(s.results).some(r => r.work === parent.id), "REPLAN_REQUIRED", "Explicitly replan an attempted item before decomposition");
                    if (ownDecomposition)
                        demand(parent.policy.name === "children-v1" || parent.policy.name === "declaration-v1" && !values(s.results).some(r => r.work === parent.id) && !parent.acceptance && !values(s.executions).some(e => e.work === parent.id && e.id !== planner!.id && (e.state === "active" || e.role !== "orchestrator" || e.mode !== "read")), "REPLAN_REQUIRED", "Cannot silently replace acceptance requirements or another attempt");
                    if (parent.policy.name !== "children-v1")
                        parent.policy = { name: "children-v1", checks: [] };
                    touch(parent);
                    if (ownDecomposition) {
                        // Only this authorized decomposition advances this coordinator's scope.
                        // Reading status or another operator's replan never refreshes it.
                        planner!.scopeRevision = parent.scopeRevision;
                        emit(s, p, "execution.planning_scope_advanced", { scopeRevision: parent.scopeRevision }, parent.id);
                    }
                }
                const id = uid("work"), key = `W${s.meta.nextKey++}`, time = now();
                const w: Work = { id, key, parent: parent?.id ?? null, title: text(c.title, "title", 200), description: c.description === undefined ? "" : text(c.description, "description", 32768, true), state: "open", revision: 1, scopeRevision: 1, policy: policy(c.policy), acceptance: null, links: list(c.links ?? [], x => text(x, "link", 2000)), phase: "", priority: c.priority === undefined ? 0 : integer(c.priority, "priority", -10000, 10000), lane: optionalText(c.lane, "lane") ?? (planner ? parent?.lane ?? null : null), resources: resources(c.resources), candidate: null, createdAt: time, updatedAt: time };
                s.work[id] = w;
                for (const key of list(c.needs ?? [], x => text(x, "needs")))
                    this.addDependency(s, findWork(s, key).id, id, "accepted");
                emit(s, p, "work.created", { key, title: w.title, parent: w.parent }, id);
                return { id, key, scopeRevision: 1 };
            }
            case "work.plan": {
                if (p.role !== "operator")
                    requirePlanner(s, p);
                const aliases: Record<string, string> = {};
                const results: unknown[] = [];
                for (const input of list(c.changes, x => validateCommand(x), 200)) {
                    demand(["work.create", "work.update", "dependency.add", "dependency.remove", "work.cancel", "work.reopen", "lane.set"].includes(input.type), "INVALID_PLAN", "Invalid plan operation", 400);
                    const change = { ...input };
                    for (const field of ["parent", "work", "prerequisite", "dependent"])
                        if (typeof change[field] === "string" && aliases[change[field] as string])
                            change[field] = aliases[change[field] as string];
                    if (Array.isArray(change.needs))
                        change.needs = change.needs.map(v => typeof v === "string" ? aliases[v] ?? v : v);
                    const r = this.command(s, p, change);
                    results.push(r);
                    if (change.alias !== undefined) {
                        const alias = text(change.alias, "alias", 80);
                        demand(!aliases[alias], "DUPLICATE_ALIAS", "Duplicate plan alias");
                        aliases[alias] = (r as {
                            id: string;
                        }).id;
                    }
                }
                return { changes: results, aliases };
            }
            case "work.update": {
                const w = findWork(s, text(c.work, "work"));
                if (p.role !== "operator") {
                    const planner = requirePlanner(s, p);
                    inPlanningScope(s, planner, w.id);
                    requireUnattempted(s, w.id);
                    demand(!flag(c.replan) && c.policy === undefined && c.lane === undefined && c.resources === undefined, "FORBIDDEN", "Workers cannot weaken policy, change budgets or authorize replanning", 403);
                }
                demand(!values(s.executions).some(e => e.work === w.id && e.state === "active") || flag(c.replan), "REPLAN_REQUIRED", "Active work requires explicit replan");
                if (c.title !== undefined)
                    w.title = text(c.title, "title", 200);
                if (c.description !== undefined)
                    w.description = text(c.description, "description", 32768, true);
                if (c.policy !== undefined)
                    w.policy = policy(c.policy);
                if (c.phase !== undefined)
                    w.phase = text(c.phase, "phase", 100, true);
                if (c.priority !== undefined)
                    w.priority = integer(c.priority, "priority", -10000, 10000);
                if (c.lane !== undefined)
                    w.lane = c.lane === null ? null : text(c.lane, "lane", 100);
                if (c.resources !== undefined)
                    w.resources = resources(c.resources);
                touch(w, ["title", "description", "policy", "lane", "resources"].some(k => c[k] !== undefined) || flag(c.replan));
                emit(s, p, "work.updated", { scopeRevision: w.scopeRevision }, w.id);
                return { id: w.id, scopeRevision: w.scopeRevision };
            }
            case "dependency.add":
            case "dependency.remove": {
                const a = findWork(s, text(c.prerequisite, "prerequisite")), b = findWork(s, text(c.dependent, "dependent"));
                if (p.role !== "operator") {
                    const planner = requirePlanner(s, p);
                    inPlanningScope(s, planner, a.id);
                    inPlanningScope(s, planner, b.id);
                    requireUnattempted(s, b.id);
                    demand(c.predicate === undefined || c.predicate === "accepted", "FORBIDDEN", "Scoped plans cannot invent legacy completion claims", 403);
                }
                const id = `${a.id}:${b.id}`;
                if (c.type === "dependency.add")
                    this.addDependency(s, a.id, b.id, choice(c.predicate ?? "accepted", ["accepted", "legacy-pass1", "legacy-after"] as const));
                else
                    delete s.dependencies[id];
                touch(b);
                emit(s, p, c.type, { prerequisite: a.id }, b.id);
                return { id };
            }
            case "work.cancel":
            case "work.reopen": {
                requireOperator(p);
                const w = findWork(s, text(c.work, "work"));
                const reason = text(c.reason, "reason");
                w.state = c.type === "work.cancel" ? "cancelled" : "open";
                touch(w);
                emit(s, p, c.type, { reason }, w.id);
                return { id: w.id };
            }
            case "lane.set": {
                requireOperator(p);
                const lane = text(c.lane, "lane", 100);
                s.lanes[lane] = { id: lane, capacity: integer(c.capacity, "capacity", 1, 1000) };
                emit(s, p, c.type, s.lanes[lane]);
                return s.lanes[lane];
            }
            case "work.report": {
                const { w, e } = target(s, p, c.work);
                const kind = choice(c.kind, ["progress", "decision", "blocked"] as const), summary = text(c.summary, "summary");
                let hold: string | null = null;
                if (kind === "blocked") {
                    hold = uid("hold");
                    s.holds[hold] = { id: hold, work: w.id, kind: "reported", reason: summary, authority: p.role === "operator" ? "operator" : "worker", execution: e?.id ?? null, resolvedAt: null };
                }
                emit(s, p, `work.${kind}`, { summary, reason: optionalText(c.reason, "reason"), hold }, w.id);
                return { work: w.id, hold };
            }
            case "hold.resolve": {
                const hold = s.holds[text(c.hold, "hold")];
                demand(hold, "NOT_FOUND", "Hold not found", 404);
                demand(p.role === "operator" || hold.authority === "worker" && p.execution === hold.execution, "FORBIDDEN", "Cannot resolve another authority's hold", 403);
                if (p.role !== "operator")
                    boundExecution(s, p, true);
                hold.resolvedAt = now();
                emit(s, p, c.type, { id: hold.id, reason: text(c.reason, "reason") }, hold.work);
                return { id: hold.id };
            }
            case "delegation.issue": {
                const w = findWork(s, text(c.work, "work"));
                const parent = p.execution ? boundExecution(s, p, true) : null;
                if (p.role !== "operator") {
                    demand(parent && (p.role === "worker" || p.role === "launcher") && parent.role === "orchestrator" && parent.mode === "read", "FORBIDDEN", "Delegation requires a scoped orchestrator", 403);
                    freshExecution(s, parent);
                    inPlanningScope(s, parent, w.id);
                }
                const role = choice(c.role ?? "implementer", ["implementer", "reviewer", "orchestrator", "validator", "integrator"] as const);
                const mode = choice(c.mode ?? "write", ["read", "write"] as const);
                demand(role !== "orchestrator" || mode === "read", "FORBIDDEN", "Delegated orchestrators must be read-only", 403);
                const token = uid("delegate"), id = uid("del");
                s.delegations[id] = { id, parent: parent?.id ?? null, work: w.id, objective: text(c.objective ?? (w.description || w.title), "objective"), tokenHash: digest(token), expiresAt: new Date(Date.now() + 3600000).toISOString(), claimedBy: null, state: "issued", issuer: p.id, device: p.device, parentGeneration: parent?.generation, parentScopeRevision: parent?.scopeRevision, workScopeRevision: w.scopeRevision, role, mode, runtimeChildId: optionalText(c.runtimeChildId, "runtimeChildId") ?? null, revokedAt: null };
                emit(s, p, c.type, { id, work: w.id }, w.id);
                return { id, token };
            }
            case "delegation.revoke": {
                const d = s.delegations[text(c.delegation, "delegation")];
                demand(d, "NOT_FOUND", "Delegation not found", 404);
                demand(p.role === "operator" || p.role === "worker" && d.parent === boundExecution(s, p, true).id, "FORBIDDEN", "Only the issuing parent or operator can revoke", 403);
                demand(!d.claimedBy, "ALREADY_CLAIMED", "Revocation cannot stop a running process; use explicit stopped-process recovery");
                d.state = "revoked";
                d.revokedAt = now();
                emit(s, p, c.type, { id: d.id, reason: text(c.reason, "reason") }, d.work);
                return { id: d.id };
            }
            case "runtime.attach": return this.attachRuntime(s, p, c);
            case "runtime.child": return this.childRuntime(s, p, c);
            case "runtime.bind": {
                const agent = adapterAgent(s, p, text(c.agent, "agent"));
                return this.bindRuntime(s, p, agent, c);
            }
            case "runtime.credentials": {
                const agent = adapterAgent(s, p, text(c.agent, "agent"));
                demand(agent.execution && agent.state !== "ended", "UNBOUND_RUNTIME_ACTOR", "Runtime actor has no active work binding", 403);
                const e = s.executions[agent.execution]!;
                demand(e.state === "active", "FENCED_EXECUTION", "Execution is inactive");
                freshExecution(s, e);
                return executionView(s, e.id, agent.id);
            }
            case "execution.start": return this.start(s, p, c);
            case "execution.recover": {
                requireOperator(p);
                demand(flag(c.stopped), "STOP_CONFIRMATION_REQUIRED", "Confirm the previous process has stopped; timeout is not fencing");
                const e = s.executions[text(c.execution, "execution")];
                demand(e, "NOT_FOUND", "Execution not found", 404);
                e.state = "interrupted";
                e.generation++;
                e.endedAt = now();
                for (const r of values(s.reservations))
                    if (r.execution === e.id)
                        r.state = "released";
                const run = s.runs[e.run]!;
                if (!values(s.executions).some(x => x.run === run.id && x.state === "active")) {
                    run.state = "ended";
                    run.endedAt = now();
                    if (run.runtimeAgent && s.runtimeAgents[run.runtimeAgent]) {
                        s.runtimeAgents[run.runtimeAgent]!.state = "ended";
                        s.runtimeAgents[run.runtimeAgent]!.endedAt = now();
                    }
                }
                emit(s, p, c.type, { id: e.id, reason: text(c.reason, "reason") }, e.work);
                return { id: e.id };
            }
            case "result.submit": {
                const { w, e } = target(s, p, c.work);
                currentScope(w, e, s);
                demand(w.policy.name !== "children-v1", "AGGREGATE_RESULT", "Aggregate work is completed by its children");
                demand(w.state !== "cancelled", "CANCELLED", "Cancelled work cannot be submitted");
                demand(!(e?.mode === "read" && w.state === "done"), "READ_ONLY_RESULT", "Review cannot replace an accepted implementation");
                const m = manifest(refs(c.manifest));
                demand(!w.candidate || equal(w.candidate, m), "ARTIFACT_CHANGED", "Submission does not match latest observed candidate");
                if (w.policy.name === "evidence-v1")
                    demand(m.length > 0, "ARTIFACT_REQUIRED", "Evidence policy needs an exact artifact version");
                const id = uid("result");
                s.results[id] = { id, work: w.id, execution: e?.id ?? null, scopeRevision: e?.scopeRevision ?? w.scopeRevision, basis: e?.basis ?? dependencyBasis(s, w), summary: text(c.summary, "summary"), manifest: m, subject: subject(m), submittedAt: now() };
                emit(s, p, c.type, { id, subject: s.results[id]!.subject }, w.id);
                return { id, work: w.id, subject: s.results[id]!.subject };
            }
            case "effect.prepare": {
                const { w, e } = target(s, p, c.work);
                currentScope(w, e, s);
                const id = text(c.effectId, "effectId"), kind = choice(c.kind, ["pr.create"] as const);
                const input = object(c.payload, ["repo", "head", "base", "title", "body"]), payload: Record<string, string> = {};
                for (const [k, v] of Object.entries(input))
                    payload[k] = text(v, k, 32768, k === "body");
                demand(payload.repo && payload.head && payload.base && payload.title, "INVALID_INPUT", "Missing PR fields", 400);
                const existing = s.effects[id];
                if (existing) {
                    demand(equal(existing.payload, payload) && existing.execution === (e?.id ?? null), "OPERATION_CONFLICT", "Effect already exists with different input");
                    return existing;
                }
                s.effects[id] = { id, kind, work: w.id, execution: e?.id ?? null, state: "prepared", payload, result: null };
                emit(s, p, c.type, { id, kind }, w.id);
                return s.effects[id];
            }
            case "effect.begin": {
                if (p.role !== "operator")
                    freshExecution(s, boundExecution(s, p, true));
                demand(p.role === "operator" || p.role === "launcher", "FORBIDDEN", "Launcher permission required", 403);
                const effect = s.effects[text(c.effectId, "effectId")];
                demand(effect, "NOT_FOUND", "Effect not found", 404);
                demand(p.role === "operator" || effect.execution === p.execution, "FORBIDDEN", "Effect outside launcher scope", 403);
                demand(effect.state === "prepared", "EXTERNAL_EFFECT_UNKNOWN", "Effect already started. Reconcile external state; do not repeat it");
                effect.state = "unknown";
                emit(s, p, c.type, { id: effect.id }, effect.work);
                return effect;
            }
            case "effect.resolve": {
                demand(p.role === "operator" || p.role === "launcher", "FORBIDDEN", "Launcher permission required", 403);
                const e = s.effects[text(c.effectId, "effectId")];
                demand(e, "NOT_FOUND", "Effect not found", 404);
                if (p.role !== "operator")
                    demand(e.execution === p.execution, "FORBIDDEN", "Effect not in scope", 403);
                const state = choice(c.state, ["unknown", "succeeded"] as const), result = c.result === undefined ? null : text(c.result, "result");
                demand(e.state !== "succeeded" || state === "succeeded" && e.result === result, "IMMUTABLE_EFFECT", "Successful external effect cannot be overwritten");
                demand(state !== "succeeded" || !!result, "INVALID_INPUT", "Successful effect needs its external result", 400);
                e.state = state;
                e.result = result;
                emit(s, p, c.type, { id: e.id, state: e.state }, e.work);
                return e;
            }
            case "import.apply": return this.import(s, p, c);
            case "migration.mode": {
                requireOperator(p);
                const source = s.sources[text(c.source, "source")];
                demand(source, "NOT_FOUND", "Import source not found", 404);
                const root = s.work[source.root]!;
                demand(text(c.confirm, "confirm") === root.key, "CONFIRMATION_REQUIRED", "Confirm the root work key");
                demand(!values(s.executions).some(e => e.state === "active" && descendants(s, root.id).has(e.work)), "ACTIVE_WRITER", "Stop active executions before changing authority");
                const mode = choice(c.mode, ["shadow", "next", "legacy"] as const);
                if (mode === "next") {
                    const scope = descendants(s, root.id);
                    demand(!values(s.work).some(w => scope.has(w.id) && w.legacy?.run.startsWith("running")), "LEGACY_WRITER_UNKNOWN", "Legacy source still declares running processes. Refresh source before cutover");
                    const comparison = object(c.comparison, ["revision", "sourceDigest", "differences"]);
                    demand(comparison.revision === s.meta.revision && comparison.sourceDigest === source.digest && Array.isArray(comparison.differences) && comparison.differences.length === 0, "SHADOW_MISMATCH", "Fresh zero-difference shadow comparison required");
                    source.comparedAt = now();
                }
                const old = source.mode;
                source.mode = mode;
                emit(s, p, c.type, { source: source.id, from: old, to: mode }, root.id);
                return source;
            }
            default: throw new Fault("INVALID_OPERATION", `Not a command: ${c.type}`, 400);
        }
    }
    private addDependency(s: State, a: string, b: string, predicate: "accepted" | "legacy-pass1" | "legacy-after"): void {
        demand(a !== b, "GRAPH_CYCLE", "Self dependency");
        if (predicate !== "accepted")
            demand(s.work[a]?.legacy && s.work[b]?.legacy, "INVALID_DEPENDENCY", "Legacy predicates require explicit imported source metadata");
        const id = `${a}:${b}`;
        s.dependencies[id] = { id, prerequisite: a, dependent: b, predicate };
    }
    private start(s: State, p: Principal, c: ObjectValue, nativeAgent?: RuntimeAgent): unknown {
        const w = findWork(s, text(c.work, "work"));
        let delegation = null;
        if (c.delegationToken !== undefined) {
            delegation = values(s.delegations).find(d => d.tokenHash === digest(text(c.delegationToken, "delegationToken")));
            demand(delegation && delegation.work === w.id && !delegation.claimedBy && delegation.expiresAt > now() && delegation.state === "issued", "INVALID_DELEGATION", "Delegation expired, revoked, claimed, or requires reissue", 403);
            demand(delegation.issuer === p.id && delegation.device === p.device && delegation.workScopeRevision === w.scopeRevision, "INVALID_DELEGATION", "Delegation owner, device or work scope changed", 403);
            if (delegation.parent) {
                const parent = s.executions[delegation.parent];
                demand(parent && parent.state === "active" && parent.generation === delegation.parentGeneration, "INVALID_DELEGATION", "Issuing parent is no longer active", 403);
                freshExecution(s, parent);
                // Adding siblings within the same authorized plan is allowed; changing the
                // actual parent requirements cannot silently refresh its Execution.
                inPlanningScope(s, parent, w.id);
            }
            demand(!delegation.runtimeChildId || nativeAgent?.externalAgentId === delegation.runtimeChildId, "INVALID_DELEGATION", "Delegation is reserved for a different runtime child", 403);
        }
        demand(p.role === "operator" || delegation && delegation.parent === p.execution && (p.role === "launcher" || p.role === "worker"), "FORBIDDEN", "Start requires operator or delegated launcher", 403);
        const role = choice(c.role ?? delegation?.role ?? "implementer", ["implementer", "reviewer", "orchestrator", "validator", "integrator"] as const), mode = choice(c.mode ?? delegation?.mode ?? "write", ["read", "write"] as const);
        if (delegation)
            demand(role === delegation.role && mode === delegation.mode, "INVALID_DELEGATION", "Role and access mode are fixed by the delegation", 403);
        const aggregate = values(s.work).some(x => x.parent === w.id);
        demand(!aggregate || role === "orchestrator" && mode === "read", "AGGREGATE_WORK", "Start a leaf; aggregate launch is read-only orchestrator only");
        for (let cursor: Work | undefined = w; cursor; cursor = cursor.parent ? s.work[cursor.parent] : undefined) {
            const source = values(s.sources).find(x => x.root === cursor!.id);
            demand(!source || source.mode === "next", "READ_ONLY_SHADOW", "Imported scope is not the active authority");
        }
        const environment = text(c.environment, "environment", 2000);
        const why = reasons(s, w, environment, mode === "read", role === "orchestrator" && mode === "read");
        demand(why.length === 0, "NOT_READY", why.join(", "));
        const continued = optionalText(c.continuedFrom, "continuedFrom");
        if (continued)
            demand(s.executions[continued]?.work === w.id && s.executions[continued]!.state !== "active", "INVALID_CONTINUATION", "Previous attempt must be stopped and refer to this work");
        const runtime = text(c.runtime ?? "generic", "runtime", 80);
        let session: string | null = null;
        if (c.session !== undefined) {
            const external = text(c.session, "session", 200);
            session = sessionFor(s, runtime, external, p.device);
        }
        let runId: string;
        if (c.existingRun !== undefined) {
            runId = text(c.existingRun, "existingRun");
            demand(s.runs[runId]?.device === p.device && s.runs[runId]!.state === "active", "INVALID_RUN", "Run must be active on this device");
            demand(s.runs[runId]!.runtime === runtime && (!session || s.runs[runId]!.session === session), "INVALID_RUN", "Run runtime/session cannot be rebound");
            demand(p.role === "operator" || nativeAgent?.run === runId, "INVALID_RUN", "Delegation cannot reuse an unrelated Run", 403);
        }
        else {
            runId = uid("run");
            const metadata: Record<string, string> = {};
            for (const [k, v] of Object.entries(object(c.metadata ?? {})))
                metadata[k] = text(v, k, 1000, true);
            s.runs[runId] = { id: runId, session, device: p.device, runtime, state: "active", startedAt: now(), endedAt: null, windows: [], metadata };
        }
        const id = uid("exec"), generation = 1;
        s.executions[id] = { id, work: w.id, run: runId, role, mode, state: "active", scopeRevision: w.scopeRevision, generation, basis: dependencyBasis(s, w), environment, continuedFrom: continued ?? null, parent: delegation?.parent ?? null, delegation: delegation?.id ?? null, startedAt: now(), endedAt: null };
        const requested = [...w.resources];
        if (mode === "write")
            requested.push({ key: `environment:${environment}`, mode: "exclusive" });
        for (const r of requested) {
            const rid = uid("reservation");
            s.reservations[rid] = { id: rid, execution: id, ...r, state: "active", generation };
        }
        if (delegation) {
            delegation.claimedBy = id;
            delegation.state = "claimed";
        }
        emit(s, p, "execution.started", { id, run: runId, role, mode, launchId: text(c.launchId, "launchId", 128) }, w.id);
        return { execution: id, run: runId, work: w.id, key: w.key, scopeRevision: w.scopeRevision, generation, role, mode, environment };
    }
    private attachRuntime(s: State, p: Principal, c: ObjectValue): unknown {
        demand(p.role === "operator" || p.role === "launcher", "FORBIDDEN", "Operator or bound launcher must attach a runtime", 403);
        const runtime = text(c.runtime, "runtime", 80), externalSessionId = text(c.externalSessionId, "externalSessionId", 300);
        const externalAgentId = text(c.agentId, "agentId", 300), invocationId = text(c.invocationId, "invocationId", 200);
        const id = digest({ owner: p.id, device: p.device, runtime, externalSessionId, externalAgentId, invocationId });
        const previous = s.runtimeAgents[id];
        if (previous) {
            demand(previous.execution && previous.state !== "ended", "FENCED_EXECUTION", "Runtime invocation ended; resume with a new invocation ID");
            const e = s.executions[previous.execution]!;
            demand(c.work === undefined || findWork(s, text(c.work, "work")).id === e.work, "RUNTIME_BINDING_CONFLICT", "Invocation is bound to another work item");
            demand(!p.execution || p.execution === e.id, "RUNTIME_BINDING_CONFLICT", "Cannot rebind another execution");
            demand(e.state === "active", "FENCED_EXECUTION", "Invocation's execution is inactive");
            freshExecution(s, e);
            return executionView(s, e.id, previous.id);
        }
        let e: Execution;
        if (p.role === "launcher") {
            e = boundExecution(s, p, true);
            freshExecution(s, e);
            demand(c.work === undefined || findWork(s, text(c.work, "work")).id === e.work, "AMBIGUOUS_CONTEXT", "Runtime attach conflicts with assigned work");
            demand(c.environment === undefined || c.environment === e.environment, "RUNTIME_BINDING_CONFLICT", "Runtime attach cannot change its environment");
        }
        else {
            const started = this.start(s, p, { work: c.work, environment: c.environment, runtime, session: externalSessionId, launchId: invocationId, role: c.role ?? "orchestrator", mode: c.mode ?? "read", continuedFrom: c.continuedFrom }) as {
                execution: string;
            };
            e = s.executions[started.execution]!;
        }
        const run = s.runs[e.run]!;
        demand(run.runtime === runtime && !run.runtimeAgent, "RUNTIME_BINDING_CONFLICT", "Run is already attached or uses another runtime");
        demand(!run.session || s.sessions[run.session]?.externalId === externalSessionId, "SESSION_CONFLICT", "Cannot change a Run's session");
        run.session = sessionFor(s, runtime, externalSessionId, p.device);
        run.runtimeAgent = id;
        run.parentRun = null;
        s.runtimeAgents[id] = { id, root: id, parent: null, runtime, externalSessionId, externalAgentId, invocationId, device: p.device, run: run.id, execution: e.id, state: "active", generation: 1, startedAt: now(), endedAt: null };
        emit(s, p, "runtime.attached", { agent: id, run: run.id, execution: e.id }, e.work, p.role === "launcher" ? "observed" : "declared");
        return executionView(s, e.id, id);
    }
    private childRuntime(s: State, p: Principal, c: ObjectValue): unknown {
        const parent = adapterAgent(s, p, text(c.parent, "parent"));
        const externalSessionId = text(c.externalSessionId, "externalSessionId", 300), externalAgentId = text(c.agentId, "agentId", 300), invocationId = text(c.invocationId, "invocationId", 200);
        const root = s.runtimeAgents[parent.root]!;
        demand(!(root.externalSessionId === externalSessionId && root.externalAgentId === externalAgentId && root.invocationId === invocationId), "RUNTIME_BINDING_CONFLICT", "A root invocation cannot become its own descendant");
        const id = agentKey(parent.root, externalSessionId, externalAgentId, invocationId);
        let agent = s.runtimeAgents[id];
        if (agent) {
            demand(agent.parent === parent.id, "RUNTIME_BINDING_CONFLICT", "Runtime child identity already has another parent");
            // Different operations carrying the same runtime occurrence are deduplicated.
            if (c.delegationToken !== undefined)
                return this.bindRuntime(s, p, agent, c);
            return { runtimeAgent: agent.id, runtimeRoot: agent.root, execution: agent.execution, state: agent.state };
        }
        demand(parent.state !== "ended", "RUNTIME_PARENT_ENDED", "Cannot start a child under an ended parent");
        const parentRun = s.runs[parent.run]!;
        const session = sessionFor(s, parent.runtime, externalSessionId, p.device, parent.externalSessionId === externalSessionId ? null : parentRun.session);
        const runId = uid("run");
        s.runs[runId] = { id: runId, session, parentRun: parent.run, runtimeAgent: id, device: p.device, runtime: parent.runtime, state: "active", startedAt: now(), endedAt: null, windows: [], metadata: { lifecycle: "native" } };
        agent = { id, root: parent.root, parent: parent.id, runtime: parent.runtime, externalSessionId, externalAgentId, invocationId, device: p.device, run: runId, execution: null, state: "active", generation: 1, startedAt: now(), endedAt: null };
        s.runtimeAgents[id] = agent;
        emit(s, p, "runtime.child_observed", { agent: id, parent: parent.id, run: runId, bound: false }, parent.execution ? s.executions[parent.execution]!.work : null, "observed");
        return c.delegationToken === undefined ? { runtimeAgent: id, runtimeRoot: agent.root, execution: null, state: agent.state } : this.bindRuntime(s, p, agent, c);
    }
    private bindRuntime(s: State, p: Principal, agent: RuntimeAgent, c: ObjectValue): unknown {
        demand(agent.parent && agent.state !== "ended", "UNBOUND_RUNTIME_ACTOR", "Only a live native child can claim delegated work");
        const parent = adapterAgent(s, p, agent.parent);
        const ticket = text(c.delegationToken, "delegationToken");
        const d = values(s.delegations).find(x => x.tokenHash === digest(ticket));
        demand(d && parent.execution && d.parent === parent.execution, "INVALID_DELEGATION", "Delegation must be issued by the observed runtime parent", 403);
        if (agent.execution) {
            const e = s.executions[agent.execution]!;
            demand(d.claimedBy === e.id && e.delegation === d.id && e.environment === text(c.environment, "environment", 2000), "RUNTIME_BINDING_CONFLICT", "Runtime child cannot change work, delegation or environment");
            demand(e.state === "active", "FENCED_EXECUTION", "Execution is inactive");
            freshExecution(s, e);
            return executionView(s, e.id, agent.id);
        }
        demand(parent.state !== "ended", "RUNTIME_PARENT_ENDED", "Ended parent cannot authorize a new work binding");
        const parentExecution = s.executions[parent.execution]!;
        const delegated: Principal = { id: p.id, device: p.device, role: "launcher", execution: parentExecution.id, generation: parentExecution.generation };
        const started = this.start(s, delegated, { work: d.work, delegationToken: ticket, environment: text(c.environment, "environment", 2000), runtime: agent.runtime, existingRun: agent.run, launchId: agent.invocationId }, agent) as {
            execution: string;
        };
        agent.execution = started.execution;
        emit(s, p, "runtime.work_bound", { agent: agent.id, execution: agent.execution, delegation: d.id }, d.work, "observed");
        return executionView(s, agent.execution, agent.id);
    }
    private import(s: State, p: Principal, c: ObjectValue): unknown {
        requireOperator(p);
        const sourceId = text(c.source, "source", 1000), sourceDigest = text(c.digest, "digest", 100), old = s.sources[sourceId];
        if (old) {
            demand(old.digest === sourceDigest, "IMPORT_CHANGED", "Source changed; compare and explicitly replan, never overwrite runtime state");
            return old;
        }
        const lanes = object(c.lanes ?? {});
        for (const [id, capacity] of Object.entries(lanes)) {
            const key = `${sourceId}:${id}`;
            s.lanes[key] = { id: key, capacity: integer(capacity, "capacity", 1, 1000) };
        }
        const root = this.command(s, p, { type: "work.create", title: text(c.title, "title", 200) }) as {
            id: string;
            key: string;
        };
        const mapping: Record<string, string> = {};
        const raw = list(c.units, x => object(x, ["key", "title", "state", "stage", "run", "gate", "writes", "needs", "after", "pass1", "writesKnown", "priority", "lane"]));
        for (const row of raw) {
            const key = text(row.key, "key", 100);
            demand(!mapping[key], "DUPLICATE_KEY", "Duplicate import key");
            const wref = this.command(s, p, { type: "work.create", title: text(row.title, "title", 200), parent: root.id, priority: integer(row.priority ?? 0, "priority", -10000, 10000), lane: `${sourceId}:${text(row.lane ?? "default", "lane", 100)}` }) as {
                id: string;
            };
            mapping[key] = wref.id;
            const w = s.work[wref.id]!;
            w.legacy = { source: sourceId, key, state: choice(row.state, ["implementation", "complete-real", "complete-mock", "out-of-scope", "blocked-owner-decision"] as const), stage: choice(row.stage, ["implementation", "ordered", "self-verified", "review-waiting", "fixing", "merge-ready", "done", "second-pass-ready", "second-pass-ordered", "shipped"] as const), run: text(row.run ?? "idle", "run", 2000), gate: text(row.gate ?? "", "gate", 2000, true), pass1: flag(row.pass1), writesKnown: flag(row.writesKnown) };
            const shared = list(c.shared ?? [], x => text(x, "shared", 1000));
            w.resources = list(row.writes ?? [], x => text(x, "write", 1000)).filter(path => !shared.some(p => path === p || p.endsWith("/") && path.startsWith(p))).map(path => ({ key: `import:${sourceId}:path:${path}`, mode: "write" }));
            w.phase = w.legacy.stage;
            // Imported progress is a claim, not fresh acceptance of current software.
            if (w.legacy.pass1)
                w.policy = { name: "evidence-v1", checks: ["imported-progress-review"] };
            if (w.legacy.state === "blocked-owner-decision") {
                const id = uid("hold");
                s.holds[id] = { id, work: w.id, kind: "decision", reason: "Imported owner decision", authority: "operator", execution: null, resolvedAt: null };
            }
        }
        for (const row of raw) {
            const b = mapping[text(row.key, "key")]!;
            for (const field of ["needs", "after"]) {
                for (const rawKey of list(row[field] ?? [], x => text(x, "dependency"))) {
                    const a = mapping[rawKey];
                    demand(a, "INVALID_DEPENDENCY", `Unknown import dependency ${rawKey}`);
                    this.addDependency(s, a, b, field === "needs" ? "legacy-pass1" : "legacy-after");
                }
            }
        }
        s.sources[sourceId] = { id: sourceId, digest: sourceDigest, root: root.id, mapping, mode: "shadow", importedAt: now(), comparedAt: null };
        emit(s, p, "source.imported", { source: sourceId, digest: sourceDigest, units: raw.length }, root.id);
        return s.sources[sourceId];
    }
}
