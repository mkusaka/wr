import type { State, Work, Principal, Event, ArtifactRef } from "./model.js";
import { demand, uid, now, values, digest, equal, manifest } from "./util.js";
export function findWork(s: State, key: string): Work {
    const w = (Object.hasOwn(s.work, key) ? s.work[key] : undefined) ?? values(s.work).find(x => x.key === key);
    demand(w, "NOT_FOUND", `Work not found: ${key}`, 404);
    return w;
}
export function emit(s: State, p: Principal, type: string, payload: unknown, work: string | null = null, source: Event["source"] = "declared"): void {
    const id = uid("evt");
    s.events[id] = { id, seq: ++s.meta.sequence, type, work, execution: p.execution ?? null, source, actor: p.id, payload, occurredAt: now(), receivedAt: now() };
}
export function descendants(s: State, id: string): Set<string> {
    const found = new Set([id]);
    let changed = true;
    while (changed) {
        changed = false;
        for (const w of values(s.work))
            if (w.parent && found.has(w.parent) && !found.has(w.id)) {
                found.add(w.id);
                changed = true;
            }
    }
    return found;
}
/** Includes completion edges child -> parent, not only start dependencies. */
export function order(s: State): string[] {
    const graph = new Map(values(s.work).map(w => [w.id, [] as string[]]));
    for (const d of values(s.dependencies)) {
        demand(graph.has(d.prerequisite) && graph.has(d.dependent), "INVALID_DEPENDENCY", "Unknown dependency");
        graph.get(d.prerequisite)!.push(d.dependent);
    }
    for (const w of values(s.work))
        if (w.parent) {
            demand(graph.has(w.parent), "INVALID_PARENT", "Unknown parent");
            graph.get(w.id)!.push(w.parent);
        }
    const marks = new Map<string, number>(), out: string[] = [];
    function visit(id: string): void {
        demand(marks.get(id) !== 1, "GRAPH_CYCLE", "Dependency/aggregation wait cycle");
        if (marks.get(id) === 2)
            return;
        marks.set(id, 1);
        for (const child of graph.get(id)!)
            visit(child);
        marks.set(id, 2);
        out.push(id);
    }
    [...graph.keys()].sort().forEach(visit);
    return out.reverse();
}
export function dependencyBasis(s: State, w: Work): Record<string, string> {
    const basis: Record<string, string> = {};
    for (const d of values(s.dependencies).filter(d => d.dependent === w.id)) {
        const upstream = s.work[d.prerequisite]!;
        if (d.predicate === "accepted" || upstream.acceptance || upstream.state === "cancelled" || upstream.scopeRevision > 1)
            basis[d.id] = upstream.acceptance ?? "unmet";
        else if (upstream.legacy?.pass1)
            basis[d.id] = digest({ source: upstream.legacy.source, key: upstream.legacy.key, pass1: true });
        else if (d.predicate === "legacy-after" && upstream.legacy?.state === "blocked-owner-decision")
            basis[d.id] = digest({ id: upstream.id, hold: "owner-decision" });
        else
            basis[d.id] = "unmet";
    }
    return basis;
}
export function reasons(s: State, w: Work, environment?: string, readOnly = false, coordinator = false): string[] {
    const why: string[] = [];
    if (w.state === "cancelled" || (!readOnly && w.state === "done"))
        why.push("terminal");
    if (values(s.holds).some(h => h.work === w.id && !h.resolvedAt))
        why.push("held");
    for (const [dep, token] of Object.entries(dependencyBasis(s, w)))
        if (token === "unmet")
            why.push(`needs:${s.work[s.dependencies[dep]!.prerequisite]!.key}`);
    if (!readOnly && values(s.executions).some(e => e.work === w.id && e.mode === "write" && e.state === "active"))
        why.push("active_writer");
    if (!coordinator && w.lane && s.lanes[w.lane]) {
        const active = values(s.executions).filter(e => e.state === "active" && !(e.role === "orchestrator" && e.mode === "read") && s.work[e.work]?.lane === w.lane).length;
        if (active >= s.lanes[w.lane]!.capacity)
            why.push(`capacity:${w.lane}`);
    }
    const requested = [...w.resources];
    if (environment && !readOnly)
        requested.push({ key: `environment:${environment}`, mode: "exclusive" });
    for (const r of requested)
        if (values(s.reservations).some(held => held.state === "active" && held.key === r.key && (held.mode === "exclusive" || r.mode === "exclusive" || held.mode === "write" && r.mode === "write")))
            why.push(`resource:${r.key}`);
    if (w.legacy && w.scopeRevision === 1) {
        if (!w.legacy.writesKnown && !w.legacy.pass1)
            why.push("legacy:closed_write_set_missing");
        if (w.legacy.run.startsWith("running"))
            why.push("legacy:live_execution_unknown");
        if (["done", "shipped"].includes(w.legacy.stage))
            why.push("legacy:terminal_claim");
        for (const other of values(s.work).filter(x => x.id !== w.id && x.legacy?.run.startsWith("running"))) {
            if (w.resources.some(r => other.resources.some(x => x.key === r.key)))
                why.push(`resource:legacy:${other.key}`);
        }
        if (w.lane && s.lanes[w.lane] && values(s.work).filter(x => x.lane === w.lane && x.legacy?.run.startsWith("running")).length + values(s.executions).filter(e => e.state === "active" && !(e.role === "orchestrator" && e.mode === "read") && s.work[e.work]?.lane === w.lane).length >= s.lanes[w.lane]!.capacity)
            why.push(`capacity:${w.lane}`);
        if (["ordered", "self-verified", "review-waiting", "fixing", "merge-ready"].includes(w.legacy.stage))
            why.push(`legacy:${w.legacy.stage}`);
        if (w.legacy.gate)
            why.push(`legacy:gate:${w.legacy.gate}`);
    }
    return [...new Set(why)];
}
export function reconcile(s: State, p: Principal): void {
    for (const id of order(s)) {
        const w = s.work[id]!;
        let candidate: {
            fingerprint: string;
            result: string | null;
            basis: Record<string, string>;
            evidence: string[];
            source: "declared" | "observed" | "derived";
        } | null = null;
        const basis = dependencyBasis(s, w);
        const eligible = w.state !== "cancelled" && !Object.values(basis).includes("unmet") && !values(s.holds).some(h => h.work === id && !h.resolvedAt);
        if (eligible) {
            const children = values(s.work).filter(c => c.parent === id);
            if (w.policy.name === "children-v1") {
                if (children.length && children.every(c => c.state === "done" && c.acceptance)) {
                    const evidence = children.map(c => c.acceptance!).sort();
                    candidate = { result: null, basis, evidence, source: "derived", fingerprint: digest({ scope: w.scopeRevision, policy: w.policy, basis, evidence }) };
                }
            }
            else {
                const results = values(s.results).filter(r => r.work === id);
                const r = results.at(-1);
                if (r && r.scopeRevision === w.scopeRevision && equal(r.basis, basis) && (!w.candidate || equal(manifest(r.manifest), manifest(w.candidate)))) {
                    const checks = w.policy.checks.map(name => values(s.checks).filter(c => c.result === r.id && c.name === name && c.subject === r.subject).at(-1));
                    if (w.policy.name === "declaration-v1" || checks.length > 0 && checks.every(c => c?.status === "passed")) {
                        const evidence = checks.filter(c => c !== undefined).map(c => c!.id);
                        candidate = { result: r.id, basis, evidence, source: w.policy.name === "declaration-v1" ? "declared" : "observed", fingerprint: digest({ scope: w.scopeRevision, policy: w.policy, basis, result: r.id, subject: r.subject, evidence }) };
                    }
                }
            }
        }
        const previous = w.acceptance ? s.acceptances[w.acceptance] : undefined;
        if (candidate && previous?.fingerprint !== candidate.fingerprint) {
            const aid = uid("accept");
            s.acceptances[aid] = { id: aid, work: id, scopeRevision: w.scopeRevision, policy: structuredClone(w.policy), ...candidate, acceptedAt: now() };
            w.acceptance = aid;
            w.state = "done";
            w.revision++;
            w.updatedAt = now();
            emit(s, p, "work.accepted", { acceptance: aid, source: candidate.source }, id, "derived");
        }
        else if (!candidate && w.acceptance) {
            const previousId = w.acceptance;
            w.acceptance = null;
            if (w.state === "done")
                w.state = "open";
            w.revision++;
            w.updatedAt = now();
            emit(s, p, "work.acceptance_invalidated", { previous: previousId }, id, "derived");
        }
    }
}
export function subject(refs: ArtifactRef[]): string { return digest(manifest(refs)); }
export function requireOperator(p: Principal): void { demand(p.role === "operator", "FORBIDDEN", "Operator permission required", 403); }
