import { test } from "bun:test";
import assert from "node:assert/strict";
import { LocalSql } from "../src/server/local-sql.js";
import { Store } from "../src/server/store.js";
import { Workspace } from "../src/domain/service.js";
import { envelope } from "../src/protocol/validate.js";
import { uid } from "../src/domain/util.js";
import { parseChecklist, legacyReadiness } from "../src/importers/checklist.js";
import { reasons } from "../src/domain/work.js";
import { explainPr } from "../src/projections/views.js";
import type { Principal } from "../src/domain/model.js";
const owner: Principal = { id: "user", device: "device", role: "operator" };
const github: Principal = { ...owner, role: "collector", checks: ["github:*"] };
const A = "a".repeat(40), B = "b".repeat(40), REPO = "github.com/example/synthetic";
function fixture() {
    const sql = new LocalSql(":memory:"), ws = new Workspace(new Store(sql));
    const cmd = (command: unknown, p = owner, observed = false): any => ws.execute(envelope({ schemaVersion: 1, operationId: uid("test"), command }), p, observed);
    return { sql, ws, cmd, state: () => ws.store.snapshot() };
}
function pr(extra: Record<string, unknown> = {}) { return { repo: REPO, number: 1, url: "https://github.com/example/synthetic/pull/1", title: "synthetic change", author: "human", head: A, base: "main", state: "open", draft: false, commits: [A], reviews: [], checks: [], updatedAt: "2026-09-01T00:00:00Z", ...extra }; }
function fails(code: string, fn: () => unknown) { assert.throws(fn, (e: any) => e.code === code); }
const checklist = `---
lanes:
  backend: 2
shared_generated:
  - src/generated/
---
# Synthetic work
## [ ] No.1 ChangeAPI
- state: implementation
- stage: implementation
- lane: backend
- writes: src/api.ts, src/generated/schema.ts
- run: idle
## [ ] No.2 ReviewAPI
- state: implementation
- stage: implementation
- lane: backend
- writes: test/api.ts
- needs: No.1
- run: idle
`;
function importCommand(input = checklist) { const report = parseChecklist(input, "synthetic"); assert.deepEqual(report.errors, []); const { errors: _e, warnings: _w, ...data } = report; return { type: "import.apply", ...data }; }
test("GitHub sync replaces current membership but keeps old head history", () => {
    const f = fixture();
    try {
        f.cmd({ type: "github.sync", pullRequest: pr() }, github, true);
        f.cmd({ type: "github.sync", pullRequest: pr({ head: B, commits: [B], updatedAt: "2026-09-02T00:00:00Z" }) }, github, true);
        const p = f.state().prs[`${REPO}#1`]!;
        assert.deepEqual(p.commits, [B]);
        assert.equal(p.snapshots.length, 2);
        assert.equal(p.publisher, null);
        assert.ok((explainPr(f.state(), REPO, 1) as any).gaps.includes("publisher_unknown"));
        const result = f.cmd({ type: "github.sync", pullRequest: pr() }, github, true);
        assert.equal(result.result.ignored, "older_snapshot");
        assert.equal(f.state().prs[p.id]!.head, B);
    }
    finally {
        f.sql.close();
    }
});
test("PR title, author or observer does not establish a publisher", () => {
    const f = fixture();
    try {
        f.cmd({ type: "github.sync", pullRequest: pr() }, github, true);
        assert.equal(f.state().prs[`${REPO}#1`]!.publisher, null);
        fails("EFFECT_MISMATCH", () => f.cmd({ type: "github.sync", pullRequest: pr(), effectId: "not-recorded" }, github, true));
    }
    finally {
        f.sql.close();
    }
});
test("publisher comes from a completed, matching creation effect", () => {
    const f = fixture();
    try {
        const w = f.cmd({ type: "work.create", title: "work" }).result;
        const e = f.cmd({ type: "execution.start", work: w.id, environment: "private", launchId: "l" }).result;
        const worker = { ...owner, role: "worker" as const, execution: e.execution };
        f.cmd({ type: "effect.prepare", work: w.id, effectId: "e1", kind: "pr.create", payload: { repo: REPO, head: "feature", base: "main", title: "change", body: "summary" } }, worker);
        f.cmd({ type: "effect.resolve", effectId: "e1", state: "succeeded", result: pr().url }, { ...worker, role: "launcher" });
        f.cmd({ type: "github.sync", pullRequest: pr(), effectId: "e1" }, { ...github, execution: e.execution }, true);
        assert.equal(f.state().prs[`${REPO}#1`]!.publisher, e.execution);
    }
    finally {
        f.sql.close();
    }
});
test("review and CI target the exact SHA and independent reviewer", () => {
    const f = fixture();
    try {
        const w = f.cmd({ type: "work.create", title: "checked", policy: { name: "evidence-v1", checks: ["ci:tests", "review:independent"] } }).result;
        f.cmd({ type: "result.submit", work: w.id, summary: "submitted", manifest: [{ repo: REPO, sha: A }] });
        const checks = [{ name: "tests", sha: A, status: "passed" }], review = (author: string, sha: string, state = "APPROVED", id = "1") => ({ id, author, sha, state });
        f.cmd({ type: "github.sync", pullRequest: pr({ checks, reviews: [review("human", A), review("other", B)] }) }, github, true);
        assert.equal(f.state().work[w.id]!.state, "open");
        f.cmd({ type: "github.sync", pullRequest: pr({ checks, reviews: [review("other", A), review("other", A, "COMMENTED", "2")] }) }, github, true);
        assert.equal(f.state().work[w.id]!.state, "done");
        const aid = f.state().work[w.id]!.acceptance;
        f.cmd({ type: "github.sync", pullRequest: pr({ checks, reviews: [review("other", A), review("other", A, "COMMENTED", "2")] }) }, github, true);
        assert.equal(f.state().work[w.id]!.acceptance, aid, "same checks do not invalidate downstream work");
        f.cmd({ type: "github.sync", pullRequest: pr({ checks, reviews: [review("other", A), review("other", A, "DISMISSED", "3")] }) }, github, true);
        assert.equal(f.state().work[w.id]!.state, "open");
    }
    finally {
        f.sql.close();
    }
});
test("a linked PR moving to a new HEAD invalidates old acceptance", () => {
    const f = fixture();
    try {
        const w = f.cmd({ type: "work.create", title: "work" }).result;
        f.cmd({ type: "effect.prepare", work: w.id, effectId: "e", kind: "pr.create", payload: { repo: REPO, head: "feature", base: "main", title: "change", body: "summary" } });
        f.cmd({ type: "effect.resolve", effectId: "e", state: "succeeded", result: pr().url });
        f.cmd({ type: "github.sync", pullRequest: pr(), effectId: "e" }, github, true);
        f.cmd({ type: "result.submit", work: w.id, summary: "done", manifest: [{ repo: REPO, sha: A }] });
        const accepted = f.state().work[w.id]!.acceptance;
        assert.ok(accepted);
        f.cmd({ type: "github.sync", pullRequest: pr({ head: B, commits: [B], updatedAt: "2026-09-02T00:00:00Z" }) }, github, true);
        assert.equal(f.state().work[w.id]!.state, "open");
        assert.ok(f.state().acceptances[accepted]);
    }
    finally {
        f.sql.close();
    }
});
test("GitHub inputs cannot change PR identity via URL", () => {
    const f = fixture();
    try {
        fails("INVALID_URL", () => f.cmd({ type: "github.sync", pullRequest: pr({ url: "https://evil.invalid/" }) }, github, true));
        assert.equal(Object.keys(f.state().prs).length, 0);
    }
    finally {
        f.sql.close();
    }
});
test("read-only importer preserves needs, writes, lanes and shared exclusions", () => {
    const f = fixture();
    try {
        const report = parseChecklist(checklist, "synthetic");
        const source = f.cmd(importCommand()).result;
        const s = f.state();
        assert.equal(source.mode, "shadow");
        const a = s.work[source.mapping["1"]]!, b = s.work[source.mapping["2"]]!;
        assert.deepEqual(a.resources.map(r => r.key), ["import:synthetic:path:src/api.ts"]);
        assert.equal(s.lanes[a.lane!]!.capacity, 2);
        assert.deepEqual(legacyReadiness(report)["1"], []);
        assert.deepEqual(reasons(s, a), []);
        assert.ok(reasons(s, b).some(x => x.startsWith("needs:")));
        fails("READ_ONLY_SHADOW", () => f.cmd({ type: "execution.start", work: a.id, environment: "test", launchId: "test" }));
        fails("READ_ONLY_SHADOW", () => f.cmd({ type: "result.submit", work: a.id, summary: "not allowed", manifest: [] }));
        assert.equal(f.cmd(importCommand()).result.root, source.root);
    }
    finally {
        f.sql.close();
    }
});
test("scope cutover, work, shadow authority rollback preserve records", () => {
    const f = fixture();
    try {
        const source = f.cmd(importCommand()).result, s = f.state(), root = s.work[source.root]!;
        fails("SHADOW_MISMATCH", () => f.cmd({ type: "migration.mode", source: source.id, mode: "next", confirm: root.key, comparison: { revision: 0, sourceDigest: source.digest, differences: [] } }));
        f.cmd({ type: "migration.mode", source: source.id, mode: "next", confirm: root.key, comparison: { revision: s.meta.revision, sourceDigest: source.digest, differences: [] } });
        const a = source.mapping["1"], b = source.mapping["2"], e = f.cmd({ type: "execution.start", work: a, environment: "test", launchId: "l" }).result;
        f.cmd({ type: "result.submit", work: a, summary: "real work submitted", manifest: [] }, { ...owner, role: "worker", execution: e.execution });
        assert.deepEqual(reasons(f.state(), f.state().work[b]!), [], "current acceptance resolves imported dependency");
        fails("ACTIVE_WRITER", () => f.cmd({ type: "migration.mode", source: source.id, mode: "legacy", confirm: root.key }));
        f.cmd({ type: "runtime.event", execution: e.execution, event: "ended", exitCode: 0 }, { ...owner, role: "launcher", execution: e.execution }, true);
        f.cmd({ type: "migration.mode", source: source.id, mode: "legacy", confirm: root.key });
        assert.equal(f.state().sources[source.id]!.mode, "legacy");
        assert.equal(Object.keys(f.state().results).length, 1);
        fails("READ_ONLY_SHADOW", () => f.cmd({ type: "work.reopen", work: a, reason: "must not mutate inactive authority" }));
    }
    finally {
        f.sql.close();
    }
});
test("legacy after releases on owner decision without claiming completion", () => {
    const text = checklist.replace("- state: implementation", "- state: blocked-owner-decision").replace("- needs: No.1", "- after: No.1");
    const f = fixture();
    try {
        const source = f.cmd(importCommand(text)).result, s = f.state();
        assert.equal(s.work[source.mapping["1"]]!.state, "open");
        assert.deepEqual(reasons(s, s.work[source.mapping["2"]]!), []);
    }
    finally {
        f.sql.close();
    }
});
test("completed legacy claim is not fabricated Acceptance", () => {
    const text = checklist.replace("## [ ] No.1", "## [x] No.1").replace("- state: implementation", "- state: complete-mock").replace("- stage: implementation", "- stage: done\n- evidence: PR #42");
    const f = fixture();
    try {
        const source = f.cmd(importCommand(text)).result, s = f.state();
        assert.equal(s.work[source.mapping["1"]]!.acceptance, null);
        assert.equal(s.work[source.mapping["1"]]!.legacy!.state, "complete-mock");
        assert.deepEqual(reasons(s, s.work[source.mapping["2"]]!), []);
    }
    finally {
        f.sql.close();
    }
});
test("active legacy writer prevents cutover even when comparison matches", () => {
    const text = checklist.replace("- stage: implementation", "- stage: ordered").replace("- run: idle", "- run: running worker:external");
    const f = fixture();
    try {
        const source = f.cmd(importCommand(text)).result, s = f.state();
        fails("LEGACY_WRITER_UNKNOWN", () => f.cmd({ type: "migration.mode", source: source.id, mode: "next", confirm: s.work[source.root]!.key, comparison: { revision: s.meta.revision, sourceDigest: source.digest, differences: [] } }));
    }
    finally {
        f.sql.close();
    }
});
test("unsupported shipment, multipass, gates, globs and cycles are reported, not guessed", () => {
    for (const input of [checklist + "- third-pass-remaining: pending\n", checklist + "- target-main-sha: " + A + "\n", checklist.replace("src/api.ts", "src/*.ts"), checklist + "- gate: special-domain-condition\n", checklist.replace("- run: idle", "- needs: No.2\n- run: idle")])
        assert.ok(parseChecklist(input, "test").errors.length);
});
test("explicit decomposition replan invalidates the old result and preserves history", () => {
    const f = fixture();
    try {
        const w = f.cmd({ type: "work.create", title: "work" }).result;
        f.cmd({ type: "result.submit", work: w.id, summary: "done", manifest: [] });
        fails("REPLAN_REQUIRED", () => f.cmd({ type: "work.create", title: "child", parent: w.id }));
        f.cmd({ type: "work.create", title: "child", parent: w.id, replan: true });
        assert.equal(f.state().work[w.id]!.state, "open");
        assert.equal(Object.keys(f.state().acceptances).length, 1);
    }
    finally {
        f.sql.close();
    }
});
test("cosmetic priority and phase updates do not invalidate requirements", () => {
    const f = fixture();
    try {
        const w = f.cmd({ type: "work.create", title: "work" }).result;
        f.cmd({ type: "result.submit", work: w.id, summary: "done", manifest: [] });
        const acceptance = f.state().work[w.id]!.acceptance;
        f.cmd({ type: "work.update", work: w.id, priority: 50, phase: "reviewed" });
        assert.equal(f.state().work[w.id]!.acceptance, acceptance);
    }
    finally {
        f.sql.close();
    }
});
