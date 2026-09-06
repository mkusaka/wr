import type { State, Principal, Work } from "../domain/model.js";
import { demand, values, equal } from "../domain/util.js";
import { descendants, findWork, reasons, dependencyBasis } from "../domain/work.js";
import { coordinatorFor, assertScope } from "../domain/coordination.js";
export type Summary = {
    id: string;
    key: string;
    title: string;
    state: string;
    phase: string;
    availability: string;
    reasons: string[];
    scopeRevision: number;
    acceptanceSource: string | null;
};
export type View = {
    assignment?: {
        work: string;
        execution: string;
        scopeRevision: number;
    } | null;
    context: {
        title: string;
        description: string;
        truncated: boolean;
    } | null;
    revision: number;
    snapshot: string;
    scope: string | null;
    items: Summary[];
    dependencies: {
        from: string;
        to: string;
        predicate: string;
    }[];
    parents: {
        from: string;
        to: string;
    }[];
    running: string[];
    ready: string[];
    submitted: string[];
    held: string[];
    interrupted: string[];
    recent: unknown[];
    cursor: number;
    hasMore: boolean;
    total: number;
};
function summary(s: State, w: Work): Summary {
    const active = values(s.executions).some(e => e.work === w.id && e.state === "active");
    const result = values(s.results).filter(r => r.work === w.id).at(-1);
    const holds = values(s.holds).some(h => h.work === w.id && !h.resolvedAt);
    const why = reasons(s, w);
    const aggregate = values(s.work).some(x => x.parent === w.id);
    const currentResult = !!result && result.scopeRevision === w.scopeRevision && equal(result.basis, dependencyBasis(s, w)) && (!w.candidate || equal(result.manifest, w.candidate));
    if (result && !currentResult)
        why.push("stale_result");
    if (currentResult && w.state !== "done")
        for (const name of w.policy.checks) {
            const last = values(s.checks).filter(c => c.result === result!.id && c.name === name).at(-1);
            if (last?.status !== "passed")
                why.push(`check:${name}:${last?.status ?? "missing"}`);
        }
    const latestExecution = values(s.executions).filter(e => e.work === w.id).at(-1);
    const availability = active ? "running" : w.state !== "open" ? "terminal" : holds ? "held" : currentResult ? "waiting_checks" : latestExecution?.state === "interrupted" ? "interrupted" : why.length ? "blocked" : aggregate ? "aggregate" : "ready";
    return { id: w.id, key: w.key, title: w.title, state: w.state, phase: w.phase, availability, reasons: why, scopeRevision: w.scopeRevision, acceptanceSource: w.acceptance ? s.acceptances[w.acceptance]!.source : null };
}
export function view(s: State, p: Principal, target?: string, since = 0, limit = 1000, offset = 0): View {
    let root: string | null = target ? findWork(s, target).id : p.execution ? s.executions[p.execution]?.work ?? null : null;
    if (p.role === "coordinator") {
        const co = coordinatorFor(s, p);
        root = root ?? (co.currentExecution ? s.executions[co.currentExecution]!.work : co.work);
        assertScope(s, co, root);
    }
    else if (p.role !== "operator") {
        const e = p.execution ? s.executions[p.execution] : undefined;
        demand(e, "FORBIDDEN", "Bound context required", 403);
        if (root)
            demand(descendants(s, e.work).has(root) || root === e.work, "FORBIDDEN", "Query outside assigned scope", 403);
        else
            root = e.work;
    }
    const allowed = root ? descendants(s, root) : new Set(Object.keys(s.work));
    const all = values(s.work).filter(w => allowed.has(w.id)).sort((a, b) => b.priority - a.priority || a.key.localeCompare(b.key, undefined, { numeric: true }));
    const items = all.slice(offset, offset + limit).map(w => summary(s, w));
    const events = values(s.events).filter(e => e.seq > since && (!root || e.work !== null && allowed.has(e.work))).sort((a, b) => a.seq - b.seq);
    const page = events.slice(0, 100);
    const coordinator = p.role === "coordinator" ? coordinatorFor(s, p) : null;
    const current = coordinator?.currentExecution ? s.executions[coordinator.currentExecution] : null;
    return { ...(coordinator ? { assignment: current ? { work: s.work[current.work]!.key, execution: current.id, scopeRevision: current.scopeRevision } : null } : {}), context: root ? { title: s.work[root]!.title, description: s.work[root]!.description.slice(0, 6000), truncated: s.work[root]!.description.length > 6000 } : null, revision: s.meta.revision, snapshot: `r${s.meta.revision}`, scope: root, items, dependencies: values(s.dependencies).filter(d => allowed.has(d.dependent)).map(d => ({ from: d.prerequisite, to: d.dependent, predicate: d.predicate })), parents: all.filter(w => w.parent && allowed.has(w.parent)).map(w => ({ from: w.parent!, to: w.id })), running: items.filter(i => i.availability === "running").map(i => i.key), ready: items.filter(i => i.availability === "ready").map(i => i.key), submitted: items.filter(i => i.availability === "waiting_checks").map(i => i.key), held: items.filter(i => i.availability === "held" || i.availability === "blocked").map(i => i.key), interrupted: items.filter(i => i.availability === "interrupted").map(i => i.key), recent: page.map(e => ({ seq: e.seq, type: e.type, work: e.work ? s.work[e.work]?.key ?? null : null, source: e.source, summary: typeof (e.payload as Record<string, unknown>)?.summary === "string" ? (e.payload as Record<string, unknown>).summary : e.type })), cursor: page.at(-1)?.seq ?? Math.max(since, s.meta.sequence), hasMore: page.length < events.length || offset + limit < all.length, total: all.length };
}
const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
export function textView(v: View): string {
    return [`${v.snapshot} · ${v.total} work items`, v.assignment ? `Assigned: ${v.assignment.work} (scope ${v.assignment.scopeRevision})` : "", v.context?.description ?? "", v.context?.truncated ? "Requirements truncated. Retrieve the complete work record before acting." : "", ...v.items.map(i => `${i.key} [${i.state}/${i.availability}] ${clean(i.title)}${i.reasons.length ? ` — ${clean(i.reasons.join(", "))}` : ""}`), v.hasMore ? "More data available; continue with cursor/pagination." : ""].filter(Boolean).join("\n");
}
const escapeLabel = (x: string) => clean(x).replace(/&/g, "#38;").replace(/"/g, "#34;").replace(/</g, "#60;").replace(/>/g, "#62;").replace(/\[/g, "#91;").replace(/\]/g, "#93;").replace(/`/g, "#96;").replace(/\\/g, "#92;");
export function mermaid(v: View): string {
    const sorted = [...v.items].sort((a, b) => a.id.localeCompare(b.id));
    const ids = new Map(sorted.map((w, i) => [w.id, `n${i}`]));
    const lines = ["flowchart LR", `    %% snapshot ${v.snapshot}`];
    for (const w of sorted)
        lines.push(`    ${ids.get(w.id)}["${escapeLabel(`${w.key} ${w.title} / ${w.state}:${w.availability}`)}"]`);
    for (const e of [...v.parents].sort((a, b) => `${a.from}${a.to}`.localeCompare(`${b.from}${b.to}`)))
        if (ids.has(e.from) && ids.has(e.to))
            lines.push(`    ${ids.get(e.from)} -. "contains" .-> ${ids.get(e.to)}`);
    for (const e of [...v.dependencies].sort((a, b) => `${a.from}${a.to}`.localeCompare(`${b.from}${b.to}`)))
        if (ids.has(e.from) && ids.has(e.to))
            lines.push(`    ${ids.get(e.from)} -->|${e.predicate}| ${ids.get(e.to)}`);
    return lines.join("\n") + "\n";
}
export function workpad(v: View): string {
    const title = v.items.find(x => x.id === v.scope)?.title ?? "Workspace";
    const lines = [`<!-- wr-next generated snapshot=${v.snapshot}; do not edit -->`, `# ${clean(title)}`, ""];
    if (v.context?.description)
        lines.push("## Objective", "", v.context.description, "", ...(v.context.truncated ? ["Description truncated; retrieve the full work record.", ""] : []));
    for (const status of ["running", "ready", "waiting_checks", "held", "blocked", "interrupted", "terminal", "aggregate"]) {
        const rows = v.items.filter(i => i.availability === status);
        if (!rows.length)
            continue;
        lines.push(`## ${status}`, "", ...rows.map(w => `- ${w.key}: ${clean(w.title)}${w.reasons.length ? ` (${w.reasons.join(", ")})` : ""}`), "");
    }
    lines.push("## Recent changes", "", ...v.recent.slice(-20).map(e => {
        const row = e as {
            work: string | null;
            type: string;
            summary: string;
        };
        return `- ${row.work ?? "workspace"}: ${clean(row.summary)}`;
    }), "");
    return lines.join("\n");
}
export function explainCommit(s: State, repo: string, sha: string): unknown {
    const id = `${repo}@${sha}`, artifact = s.artifacts[id];
    demand(artifact, "NOT_FOUND", "Commit not recorded", 404);
    const context = artifact.context ? s.contexts[artifact.context] : null;
    return { artifact, context, contributions: values(s.contributions).filter(c => c.artifact === id), rewrites: values(s.rewrites).filter(r => r.repo === repo && (r.old === sha || r.new === sha)), gaps: artifact.gaps };
}
export function explainPr(s: State, repo: string, number: number): unknown {
    const pr = s.prs[`${repo}#${number}`];
    demand(pr, "NOT_FOUND", "PR not recorded", 404);
    const contributions = values(s.contributions).filter(c => pr.commits.some(sha => c.artifact === `${repo}@${sha}`));
    return { pr, contributions, coverage: { total: pr.commits.length, tracked: pr.commits.filter(sha => s.artifacts[`${repo}@${sha}`]?.context).length }, gaps: [...(!pr.publisher ? ["publisher_unknown"] : []), ...pr.commits.filter(sha => !s.artifacts[`${repo}@${sha}`]?.context).map(sha => `untracked:${sha}`)] };
}
