import { digest } from "../domain/util.js";
export type LegacyUnit = {
    key: string;
    title: string;
    state: string;
    stage: string;
    run: string;
    gate: string;
    writes: string[];
    needs: string[];
    after: string[];
    pass1: boolean;
    writesKnown: boolean;
    priority: number;
    lane: string;
};
export type ImportReport = {
    source: string;
    digest: string;
    title: string;
    units: LegacyUnit[];
    lanes: Record<string, number>;
    shared: string[];
    errors: {
        line: number;
        code: string;
        message: string;
    }[];
    warnings: string[];
};
const states = new Set(["implementation", "complete-real", "complete-mock", "out-of-scope", "blocked-owner-decision"]);
const done = new Set(["complete-real", "complete-mock", "out-of-scope"]);
const stages = new Set(["implementation", "ordered", "self-verified", "review-waiting", "fixing", "merge-ready", "done", "second-pass-ready", "second-pass-ordered", "shipped"]);
const pass1 = new Set(["done", "second-pass-ready", "second-pass-ordered", "shipped"]);
/** Read-only, deliberately bounded grammar. Never infer unsupported business rules. */
export function parseChecklist(input: string, source: string): ImportReport {
    const out: ImportReport = { source, digest: digest(input), title: source, units: [], lanes: {}, shared: [], errors: [], warnings: [] };
    const error = (line: number, code: string, message: string) => out.errors.push({ line, code, message });
    let current: (LegacyUnit & {
        box: boolean;
        evidence: string;
        line: number;
    }) | null = null, block = "";
    const rows: (LegacyUnit & {
        box: boolean;
        evidence: string;
        line: number;
    })[] = [];
    for (const [i, line] of input.split(/\r?\n/).entries()) {
        if (line.startsWith("# "))
            out.title = line.slice(2).trim();
        if (line === "lanes:" || line === "shared_generated:") {
            block = line.slice(0, -1);
            continue;
        }
        if (block === "lanes") {
            const match = line.match(/^  ([\w.-]+):\s*(\d+)\s*$/);
            if (match) {
                const cap = Number(match[2]);
                if (cap < 1)
                    error(i + 1, "INVALID_CAPACITY", "Lane capacity must be positive");
                out.lanes[match[1]!] = cap;
                continue;
            }
            block = "";
        }
        if (block === "shared_generated") {
            const match = line.match(/^  - (\S+)\s*$/);
            if (match) {
                out.shared.push(match[1]!);
                continue;
            }
            block = "";
        }
        const heading = line.match(/^## \[([ x])\] No\.(\d+)\s+(.+)$/);
        if (heading) {
            current = { key: heading[2]!, title: heading[3]!, state: "", stage: "implementation", run: "idle", gate: "", writes: [], needs: [], after: [], pass1: false, writesKnown: false, priority: 0, lane: "default", box: heading[1] === "x", evidence: "", line: i + 1 };
            rows.push(current);
            continue;
        }
        if (!current)
            continue;
        const meta = line.match(/^- ([\w-]+):\s*(.*)$/);
        if (!meta)
            continue;
        const key = meta[1]!, value = meta[2]!.trim().replace(/^`(.*)`$/, "$1");
        if (["state", "stage", "run", "gate", "lane", "evidence"].includes(key))
            (current as unknown as Record<string, unknown>)[key] = value;
        else if (key === "needs" || key === "after")
            current[key] = value ? value.split(",").map(x => x.trim().replace(/^No\./, "")) : [];
        else if (key === "writes") {
            current.writesKnown = Boolean(value);
            current.writes = value ? value.split(",").map(x => x.trim()) : [];
        }
        else if (key === "priority") {
            current.priority = Number(value);
            if (!Number.isSafeInteger(current.priority))
                error(i + 1, "INVALID_PRIORITY", "Integer priority required");
        }
        else if (/^(second|third|fourth|fifth)-pass-/.test(key) && value)
            error(i + 1, "UNSUPPORTED_MULTI_PASS_EVIDENCE", `${key} requires source-specific verification; not reduced to completion`);
        else if (["target-main-sha", "ac-dispositions", "merge-ancestry", "e2e-scenarios"].includes(key) && value)
            error(i + 1, "UNSUPPORTED_SHIPMENT_EVIDENCE", `${key} needs an exact shipment verifier`);
    }
    const keys = new Set<string>();
    for (const u of rows) {
        if (keys.has(u.key))
            error(u.line, "DUPLICATE_KEY", `Duplicate No.${u.key}`);
        keys.add(u.key);
        if (!states.has(u.state))
            error(u.line, "UNKNOWN_STATE", `Unknown state ${u.state}`);
        if (!stages.has(u.stage))
            error(u.line, "UNKNOWN_STAGE", `Unknown stage ${u.stage}`);
        if (u.box !== done.has(u.state))
            error(u.line, "CHECKBOX_MISMATCH", `No.${u.key} checkbox does not match state`);
        if (u.run.startsWith("running") && u.stage === "implementation")
            error(u.line, "UNRECORDED_ORDER", `No.${u.key} running without ordered stage`);
        if (pass1.has(u.stage) && !/(?:#\d+|\b[0-9a-f]{7,64}\b)/i.test(u.evidence))
            error(u.line, "MISSING_PROGRESS_EVIDENCE", `No.${u.key} lacks original PR/commit reference`);
        if (u.gate && !['human', 'owner-decision'].includes(u.gate))
            error(u.line, "UNSUPPORTED_GATE", `Gate must have an explicit adapter: ${u.gate}`);
        if (u.stage === "shipped")
            error(u.line, "UNSUPPORTED_SHIPMENT", `No.${u.key}: shipment requires exact-SHA audit; import refused`);
        for (const path of u.writes)
            if (/[*?\[{}]/.test(path) || path.startsWith("/") || path.split("/").includes(".."))
                error(u.line, "UNSUPPORTED_WRITE_PATTERN", `Only exact repository-relative paths supported: ${path}`);
        u.pass1 = pass1.has(u.stage) || done.has(u.state);
        if (u.pass1)
            out.warnings.push(`No.${u.key}: imported progress claim, not verified current acceptance`);
    }
    for (const u of rows)
        for (const dep of [...u.needs, ...u.after])
            if (!keys.has(dep))
                error(u.line, "UNKNOWN_DEPENDENCY", `No.${dep} not found`);
    // A legacy after-cycle may be legal in old policy. Refuse rather than change its meaning.
    const visiting = new Set<string>(), visited = new Set<string>();
    const walk = (key: string) => {
        if (visiting.has(key)) {
            error(0, "DEPENDENCY_CYCLE", `Cycle including No.${key}; cannot map safely`);
            return;
        }
        if (visited.has(key))
            return;
        visiting.add(key);
        const u = rows.find(u => u.key === key);
        if (u)
            for (const d of [...u.needs, ...u.after])
                walk(d);
        visiting.delete(key);
        visited.add(key);
    };
    for (const key of keys)
        walk(key);
    out.units = rows.map(({ box: _box, evidence: _evidence, line: _line, ...unit }) => unit);
    if (!out.units.length)
        error(0, "NO_UNITS", "No checklist unit headings found");
    return out;
}
/** Pure reference projection for supported input; external live reservations remain unknown. */
export function legacyReadiness(report: ImportReport): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    const by = new Map(report.units.map(u => [u.key, u]));
    for (const u of report.units) {
        const why: string[] = [];
        if (u.state === "blocked-owner-decision")
            why.push("held");
        if (u.run.startsWith("running"))
            why.push("external_running");
        if (["done", "shipped"].includes(u.stage))
            why.push("legacy_terminal");
        if (["ordered", "self-verified", "review-waiting", "fixing", "merge-ready"].includes(u.stage))
            why.push(`phase:${u.stage}`);
        if (!u.writesKnown && !u.pass1)
            why.push("writes_missing");
        if (u.gate)
            why.push("gate");
        for (const d of u.needs)
            if (!by.get(d)?.pass1)
                why.push(`needs:${d}`);
        for (const d of u.after)
            if (!by.get(d)?.pass1 && by.get(d)?.state !== "blocked-owner-decision")
                why.push(`after:${d}`);
        for (const active of report.units.filter(a => a.key !== u.key && a.run.startsWith("running"))) {
            const own = (paths: string[]) => paths.filter(p => !report.shared.some(shared => p === shared || shared.endsWith("/") && p.startsWith(shared)));
            if (own(u.writes).some(p => own(active.writes).includes(p)))
                why.push(`resource:${active.key}`);
        }
        if (report.lanes[u.lane] !== undefined && report.units.filter(a => a.run.startsWith("running") && a.lane === u.lane).length >= report.lanes[u.lane]!)
            why.push(`capacity:${u.lane}`);
        out[u.key] = why.sort();
    }
    return out;
}
