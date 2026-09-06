import type { Principal, State } from "../domain/model.js";
import { demand, values } from "../domain/util.js";
import { adapterAgent, boundExecution } from "../domain/runtime.js";
import { descendants } from "../domain/work.js";
export function runtimeView(s: State, p: Principal) {
    const scope = p.role === "operator" || p.role === "adapter" ? null : descendants(s, boundExecution(s, p).work);
    if (p.role === "adapter")
        adapterAgent(s, p, p.runtimeRoot ?? "");
    const allowed = values(s.runtimeAgents).filter(a => p.role === "operator" || p.role === "adapter" && a.root === p.runtimeRoot || scope && a.execution && scope.has(s.executions[a.execution]!.work));
    const ids = new Set(allowed.map(a => a.id));
    const nodes = allowed.sort((a, b) => a.id.localeCompare(b.id)).map(a => {
        const parent = a.parent ? s.runtimeAgents[a.parent] : null;
        const e = a.execution ? s.executions[a.execution] : null;
        const childrenActive = values(s.runtimeAgents).filter(c => c.parent === a.id && c.state !== "ended").length;
        return { id: a.id, parent: a.parent && ids.has(a.parent) ? a.parent : null, runtime: a.runtime, session: a.externalSessionId, agentId: a.externalAgentId, invocation: a.invocationId, run: a.run, execution: a.execution, work: e ? s.work[e.work]!.key : null, delegation: e?.delegation ?? null, continuedFrom: e?.continuedFrom ?? null, state: a.state, orphan: !!parent && parent.state === "ended" && a.state !== "ended", unassigned: !e, childrenActive, endedAt: a.endedAt };
    });
    return { snapshot: `r${s.meta.revision}`, nodes };
}
export function runtimeMermaid(v: ReturnType<typeof runtimeView>): string {
    const ids = new Map(v.nodes.map((n, i) => [n.id, `a${i}`]));
    const esc = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/&/g, "#38;").replace(/"/g, "#34;").replace(/</g, "#60;").replace(/>/g, "#62;").replace(/\[/g, "#91;").replace(/\]/g, "#93;").replace(/`/g, "#96;").replace(/\\/g, "#92;");
    const lines = ["flowchart TD", `    %% runtime hierarchy ${v.snapshot}`];
    for (const n of v.nodes)
        lines.push(`    ${ids.get(n.id)}["${esc(`${n.runtime}:${n.agentId} / ${n.work ?? "unassigned"} / ${n.state}${n.orphan ? " / orphan" : ""}`)}"]`);
    for (const n of v.nodes)
        if (n.parent) {
            demand(ids.has(n.parent), "INVALID_RUNTIME_GRAPH", "Missing projected runtime parent");
            lines.push(`    ${ids.get(n.parent)} -->|spawned| ${ids.get(n.id)}`);
        }
    return lines.join("\n") + "\n";
}
export type RuntimeView = ReturnType<typeof runtimeView>;
