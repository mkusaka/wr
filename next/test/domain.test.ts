import { test } from "bun:test";
import assert from "node:assert/strict";
import { LocalSql } from "../src/server/local-sql.js";
import { Store } from "../src/server/store.js";
import { Workspace } from "../src/domain/service.js";
import { envelope } from "../src/protocol/validate.js";
import { uid, digest } from "../src/domain/util.js";
import { subject, reasons, findWork } from "../src/domain/work.js";
import { view, mermaid, workpad } from "../src/projections/views.js";
import type { Principal, CommitSnapshot } from "../src/domain/model.js";
const owner: Principal = { id: "user", device: "device", role: "operator" };
const SHA = "a".repeat(40), OTHER = "b".repeat(40);
function fixture() {
    const sql = new LocalSql(":memory:"), ws = new Workspace(new Store(sql));
    const cmd = (command: unknown, p = owner, observed = false, id = uid("test"), revision?: number): any => ws.execute(envelope({ schemaVersion: 1, operationId: id, expectedRevision: revision, command }), p, observed);
    const add = (title = "work", extra: Record<string, unknown> = {}) => cmd({ type: "work.create", title, ...extra }).result;
    const start = (work: string, extra: Record<string, unknown> = {}) => cmd({ type: "execution.start", work, environment: uid("env"), launchId: uid("launch"), ...extra }).result;
    const worker = (execution: string): Principal => ({ ...owner, role: "worker", execution });
    const collector = (execution?: string, checks = ["test", "git:*", "github:*"]): Principal => ({ ...owner, role: "collector", execution, checks });
    return { sql, ws, cmd, add, start, worker, collector, state: () => ws.store.snapshot() };
}
function rejects(code: string, fn: () => unknown) { assert.throws(fn, (e: any) => e.code === code); }
test("dependency and child aggregation determine current frontier", () => {
    const f = fixture();
    const parent = f.add("parent"), a = f.add("A", { parent: parent.id }), b = f.add("B", { parent: parent.id, needs: [a.id] });
    assert.match(reasons(f.state(), findWork(f.state(), b.id)).join(), /needs/);
    f.cmd({ type: "result.submit", work: a.id, summary: "done", manifest: [] });
    assert.equal(f.state().work[a.id]!.state, "done");
    assert.deepEqual(reasons(f.state(), f.state().work[b.id]!), []);
    f.cmd({ type: "result.submit", work: b.id, summary: "done", manifest: [] });
    assert.equal(f.state().work[parent.id]!.state, "done");
    f.sql.close();
});
test("cancelled child does not satisfy parent or dependent", () => { const f = fixture(), a = f.add(), b = f.add("b", { needs: [a.id] }); f.cmd({ type: "work.cancel", work: a.id, reason: "cancelled" }); assert.equal(f.state().work[a.id]!.acceptance, null); assert.match(reasons(f.state(), f.state().work[b.id]!).join(), /needs/); f.sql.close(); });
test("empty children policy cannot complete itself", () => { const f = fixture(), a = f.add("a", { policy: { name: "children-v1", checks: [] } }); assert.equal(f.state().work[a.id]!.state, "open"); f.sql.close(); });
test("plan rollback on dependency cycle includes creates, events and key counter", () => {
    const f = fixture(), before = f.state();
    rejects("GRAPH_CYCLE", () => f.cmd({ type: "work.plan", changes: [{ type: "work.create", title: "a", alias: "a" }, { type: "work.create", title: "b", alias: "b", needs: ["a"] }, { type: "dependency.add", prerequisite: "b", dependent: "a" }] }));
    assert.deepEqual(f.state(), before);
    f.sql.close();
});
test("parent completion and child start cannot form a wait cycle", () => { const f = fixture(), p = f.add(), c = f.add("child", { parent: p.id }); rejects("GRAPH_CYCLE", () => f.cmd({ type: "dependency.add", prerequisite: p.id, dependent: c.id })); f.sql.close(); });
test("same write work is claimed only once", () => { const f = fixture(), w = f.add(); f.start(w.id); rejects("NOT_READY", () => f.start(w.id)); assert.equal(Object.keys(f.state().executions).length, 1); f.sql.close(); });
test("different work cannot write the same environment", () => { const f = fixture(), a = f.add(), b = f.add(); f.start(a.id, { environment: "shared" }); rejects("NOT_READY", () => f.start(b.id, { environment: "shared" })); f.sql.close(); });
test("different isolated environments can operate concurrently", () => { const f = fixture(), a = f.add(), b = f.add(); f.start(a.id, { environment: "a" }); f.start(b.id, { environment: "b" }); assert.equal(Object.keys(f.state().executions).length, 2); f.sql.close(); });
test("a read-only reviewer can coexist with a writer", () => { const f = fixture(), w = f.add(); f.start(w.id); f.start(w.id, { role: "reviewer", mode: "read" }); assert.equal(Object.keys(f.state().executions).length, 2); f.sql.close(); });
test("lane capacity is enforced atomically", () => { const f = fixture(); f.cmd({ type: "lane.set", lane: "build", capacity: 1 }); const a = f.add("a", { lane: "build" }), b = f.add("b", { lane: "build" }); f.start(a.id); rejects("NOT_READY", () => f.start(b.id)); f.sql.close(); });
test("idempotency replays original response without new records", () => { const f = fixture(); const c = { type: "work.create", title: "a" }; const a = f.cmd(c, owner, false, "same"); const b = f.cmd(c, owner, false, "same"); assert.deepEqual(a, b); assert.equal(Object.keys(f.state().work).length, 1); rejects("OPERATION_CONFLICT", () => f.cmd({ ...c, title: "b" }, owner, false, "same")); f.sql.close(); });
test("stale snapshot is not silently rebased", () => { const f = fixture(); f.add(); rejects("VERSION_CONFLICT", () => f.cmd({ type: "work.create", title: "b" }, owner, false, uid("test"), 0)); f.sql.close(); });
test("worker scope cannot be overridden by target parameter", () => { const f = fixture(), a = f.add(), b = f.add(), e = f.start(a.id); rejects("AMBIGUOUS_CONTEXT", () => f.cmd({ type: "result.submit", work: b.id, summary: "fake", manifest: [] }, f.worker(e.execution))); f.sql.close(); });
test("worker cannot replan or forge a trusted check", () => { const f = fixture(), w = f.add(), e = f.start(w.id), p = f.worker(e.execution); rejects("FORBIDDEN", () => f.cmd({ type: "work.update", work: w.id, title: "changed" }, p)); rejects("UNAUTHORIZED_OBSERVATION", () => f.cmd({ type: "check.record", result: "x", subject: "x", name: "test", status: "passed" }, p, true)); f.sql.close(); });
test("device ownership is not reassigned by another user", () => { const f = fixture(); f.add(); rejects("FORBIDDEN", () => f.cmd({ type: "work.create", title: "bad" }, { ...owner, id: "other" })); f.sql.close(); });
test("declaration receipt is not a validation attestation", () => { const f = fixture(), w = f.add(), e = f.start(w.id); f.cmd({ type: "result.submit", summary: "done", manifest: [] }, f.worker(e.execution)); const s = f.state(); assert.equal(s.acceptances[s.work[w.id]!.acceptance!]!.source, "declared"); assert.equal(s.executions[e.execution]!.state, "active"); assert.ok(Object.values(s.reservations).every(r => r.state === "active")); f.sql.close(); });
test("exit zero without submission leaves interrupted, not done", () => { const f = fixture(), w = f.add(), e = f.start(w.id); f.cmd({ type: "runtime.event", event: "ended", execution: e.execution, exitCode: 0 }, { ...owner, role: "launcher", execution: e.execution }, true); assert.equal(f.state().work[w.id]!.state, "open"); assert.equal(f.state().executions[e.execution]!.state, "interrupted"); f.sql.close(); });
test("evidence policy requires exact artifact and only assigned collector", () => {
    const f = fixture(), w = f.add("code", { policy: { name: "evidence-v1", checks: ["test"] } }), e = f.start(w.id);
    const r = f.cmd({ type: "result.submit", summary: "submitted", manifest: [{ repo: "local:r", sha: SHA }] }, f.worker(e.execution)).result;
    assert.equal(f.state().work[w.id]!.state, "open");
    rejects("SUBJECT_MISMATCH", () => f.cmd({ type: "check.record", result: r.id, name: "test", subject: subject([{ repo: "local:r", sha: OTHER }]), status: "passed" }, f.collector(e.execution), true));
    rejects("UNAUTHORIZED_OBSERVATION", () => f.cmd({ type: "check.record", result: r.id, name: "test", subject: r.subject, status: "passed" }, f.collector(e.execution, []), true));
    f.cmd({ type: "check.record", result: r.id, name: "test", subject: r.subject, status: "passed" }, f.collector(e.execution), true);
    assert.equal(f.state().work[w.id]!.state, "done");
    f.cmd({ type: "check.record", result: r.id, name: "test", subject: r.subject, status: "failed" }, f.collector(e.execution), true);
    assert.equal(f.state().work[w.id]!.state, "open");
    assert.equal(Object.keys(f.state().acceptances).length, 1);
    f.sql.close();
});
test("requirement changes invalidate acceptance but preserve history", () => { const f = fixture(), w = f.add(); f.cmd({ type: "result.submit", work: w.id, summary: "done", manifest: [] }); f.cmd({ type: "work.update", work: w.id, description: "new requirement" }); const s = f.state(); assert.equal(s.work[w.id]!.state, "open"); assert.equal(Object.keys(s.results).length, 1); assert.equal(Object.keys(s.acceptances).length, 1); f.sql.close(); });
test("requirement changes fence a stale execution submission", () => { const f = fixture(), w = f.add(), e = f.start(w.id); f.cmd({ type: "work.update", work: w.id, description: "new", replan: true }); rejects("STALE_SCOPE", () => f.cmd({ type: "result.submit", summary: "old work", manifest: [] }, f.worker(e.execution))); f.sql.close(); });
test("upstream re-open invalidates downstream's old basis", () => { const f = fixture(), a = f.add(), b = f.add("b", { needs: [a.id] }); f.cmd({ type: "result.submit", work: a.id, summary: "a", manifest: [] }); f.cmd({ type: "result.submit", work: b.id, summary: "b", manifest: [] }); f.cmd({ type: "work.reopen", work: a.id, reason: "new attempt" }); assert.equal(f.state().work[b.id]!.state, "open"); f.sql.close(); });
test("human hold cannot be released by worker", () => { const f = fixture(), w = f.add(), e = f.start(w.id); const h = f.cmd({ type: "work.report", work: w.id, kind: "blocked", summary: "approval" }).result.hold; rejects("FORBIDDEN", () => f.cmd({ type: "hold.resolve", hold: h, reason: "I approve" }, f.worker(e.execution))); f.sql.close(); });
test("fencing never comes from heartbeat expiration alone", () => { const f = fixture(), w = f.add(), e = f.start(w.id); f.cmd({ type: "runtime.event", event: "unknown", execution: e.execution }, f.collector(e.execution), true); rejects("NOT_READY", () => f.start(w.id)); rejects("STOP_CONFIRMATION_REQUIRED", () => f.cmd({ type: "execution.recover", execution: e.execution, reason: "timeout" })); f.cmd({ type: "execution.recover", execution: e.execution, reason: "stopped externally", stopped: true }); rejects("FENCED_EXECUTION", () => f.cmd({ type: "result.submit", summary: "late", manifest: [] }, f.worker(e.execution))); const retry = f.start(w.id, { continuedFrom: e.execution }); assert.notEqual(retry.execution, e.execution); f.sql.close(); });
test("context rollover is not a new run or attempt", () => {
    const f = fixture(), w = f.add(), e = f.start(w.id);
    for (const window of ["a", "b", "b"])
        f.cmd({ type: "runtime.event", event: "window", execution: e.execution, windowId: window, externalSessionId: "session" }, f.collector(e.execution), true);
    assert.equal(Object.keys(f.state().runs).length, 1);
    assert.equal(Object.keys(f.state().executions).length, 1);
    assert.deepEqual(f.state().runs[e.run]!.windows, ["a", "b"]);
    f.sql.close();
});
test("same run can have different scoped executions", () => { const f = fixture(), a = f.add(), b = f.add(), e = f.start(a.id, { mode: "read" }); const e2 = f.start(b.id, { mode: "read", existingRun: e.run }); assert.equal(e2.run, e.run); assert.notEqual(e2.execution, e.execution); f.sql.close(); });
test("delegation token is single use and scope bound", () => {
    const f = fixture(), p = f.add(), c = f.add("child", { parent: p.id }), other = f.add();
    const e = f.start(p.id, { mode: "read", role: "orchestrator" });
    const d = f.cmd({ type: "delegation.issue", work: c.id, objective: "child" }, f.worker(e.execution)).result;
    rejects("FORBIDDEN", () => f.cmd({ type: "delegation.issue", work: other.id, objective: "other" }, f.worker(e.execution)));
    const start = { type: "execution.start", work: c.id, environment: "child", launchId: "child", delegationToken: d.token };
    f.cmd(start, f.worker(e.execution));
    rejects("INVALID_DELEGATION", () => f.cmd({ ...start, environment: "new", launchId: "another" }, f.worker(e.execution)));
    f.sql.close();
});
test("unsupported policies and unexpected authority fields are rejected", () => { const f = fixture(); assert.throws(() => f.add("bad", { policy: { name: "invented", checks: [] } })); assert.throws(() => f.cmd({ type: "work.create", title: "bad", verified: true })); f.sql.close(); });
test("projections share state, escape user titles and include cursor", () => { const f = fixture(), w = f.add('a\"] --> injected["<script>'); const v = view(f.state(), owner); assert.equal(v.items[0]!.key, w.key); assert.match(workpad(v), /snapshot=r/); const graph = mermaid(v); assert.ok(!graph.includes("<script>")); assert.equal(graph.split("\n").filter(l => l.includes(" -->|")).length, 0); assert.equal(mermaid(v), mermaid(v)); f.sql.close(); });
test("git context binding mismatch is quarantined, not invented attribution", () => { const f = fixture(), w = f.add(), e = f.start(w.id); const snapshot: CommitSnapshot = { id: "ctx", work: w.id, execution: e.execution, scopeRevision: 1, generation: 1, repo: "local:r", tree: OTHER, base: null, branch: "main", capturedAt: new Date().toISOString(), contributors: [] }; const r = f.cmd({ type: "git.commit", snapshot, snapshotDigest: digest(snapshot), commit: { repo: "local:r", sha: SHA, tree: SHA, parents: [], subject: "x", author: "A", committer: "A" } }, f.collector(e.execution), true); assert.deepEqual(r.result.gaps, ["tree_mismatch"]); assert.ok(!Object.values(f.state().contributions).some(c => c.relation === "committed_by")); f.sql.close(); });
