import { test } from "bun:test";
import assert from "node:assert/strict";
import { startLocal } from "../src/server/local.js";
import { Client } from "../src/cli/client.js";
import type { Connection } from "../src/cli/files.js";
import { uid, digest } from "../src/domain/util.js";
const fail = (code: string) => (e: any) => e.code === code;
async function fixture(checks: string[] = []) {
    const server = await startLocal({ database: ":memory:" });
    const cfg: Connection = { server: server.url, workspace: "local", device: "co-test", token: server.secret };
    const operator = new Client(cfg);
    const enable = await operator.command({ type: "coordination.enable", repository: "repo-A", environment: "env-A", runtimes: ["harness"], title: "Repository", checks });
    const boot = new Client({ ...cfg, token: enable.bootstrap });
    const open = async (invocation = uid("invocation")) => {
        const attached = await boot.command({ type: "coordination.open", runtime: "harness", environment: "env-A", session: "session", actor: "root", invocation });
        const coordinator = new Client({ ...cfg, token: attached.capabilities.coordinator });
        const runtime = new Client({ ...cfg, token: attached.capabilities.runtime });
        const adapter = new Client({ ...cfg, token: attached.capabilities.adapter });
        const tool = async (id = uid("tool")) => {
            const dispatch = await runtime.command({ type: "coordination.dispatch", toolId: id, inputDigest: id });
            const client = new Client({ ...cfg, token: dispatch.capabilities.coordinator });
            const close = () => runtime.command({ type: "coordination.dispatch.close", dispatch: dispatch.result.dispatch });
            return { dispatch, client, close, worker: dispatch.capabilities.worker ? new Client({ ...cfg, token: dispatch.capabilities.worker }) : null };
        };
        return { attached, coordinator, runtime, adapter, tool };
    };
    const root = await open("root-invocation");
    const add = async (title: string, extra: Record<string, unknown> = {}) => {
        const t = await root.tool();
        try {
            return (await t.client.command({ type: "work.create", title, ...extra })).result;
        }
        finally {
            await t.close();
        }
    };
    return { server, cfg, operator, enable, boot, open, root, add, state: () => server.workspace.store.snapshot(), close: () => server.close() };
}
test("coordinator bootstrap creates no artificial execution or reservation", async () => {
    const f = await fixture();
    try {
        const s = f.state();
        assert.equal(Object.keys(s.runs).length, 1);
        assert.equal(Object.keys(s.executions).length, 0);
        assert.equal(Object.keys(s.reservations).length, 0);
        assert.equal(Object.values(s.runtimeAgents)[0]!.execution, null);
        assert.equal((await f.root.coordinator.request<any>("/v1/ready")).ready.length, 0);
        await assert.rejects(f.boot.command({ type: "work.create", title: "escalate" }), fail("FORBIDDEN"));
        await assert.rejects(f.boot.request("/v1/status"), fail("FORBIDDEN"));
    }
    finally {
        await f.close();
    }
});
test("coordinator plans inside a repository without Work/Execution ids", async () => {
    const f = await fixture();
    try {
        const t = await f.root.tool();
        const response = await t.client.command({ type: "work.plan", changes: [{ type: "work.create", title: "API", alias: "api" }, { type: "work.create", title: "Review", needs: ["api"] }] });
        await t.close();
        assert.equal(f.state().work[response.result.aliases.api]!.parent, f.enable.result.work);
        const v = await f.root.coordinator.request<any>("/v1/ready");
        assert.deepEqual(v.ready.map((x: any) => x.title), ["API"]);
        assert.equal(Object.keys(f.state().executions).length, 0);
    }
    finally {
        await f.close();
    }
});
test("coordinator rejects root edits, operator holds, policy weakening and scope escape atomically", async () => {
    const f = await fixture();
    try {
        const foreign = (await f.operator.command({ type: "work.create", title: "Foreign" })).result;
        const own = await f.add("Own");
        const t = await f.root.tool();
        for (const c of [
            { type: "work.create", title: "Escaped", parent: foreign.id },
            { type: "work.update", work: f.enable.result.work, title: "Replace goal" },
            { type: "work.update", work: own.id, policy: { name: "declaration-v1", checks: [] } },
            { type: "dependency.add", prerequisite: foreign.id, dependent: own.id },
            { type: "lane.set", lane: "all", capacity: 100 },
            { type: "execution.start", work: own.id, environment: "env-A", launchId: "bypass" },
            { type: "result.submit", summary: "fake" },
        ]) {
            const before = f.state();
            await assert.rejects(t.client.command(c));
            assert.deepEqual(f.state(), before);
        }
        const before = f.state();
        await assert.rejects(t.client.command({ type: "work.plan", changes: [{ type: "work.create", title: "Should rollback" }, { type: "work.update", work: foreign.id, title: "bad" }] }));
        assert.deepEqual(f.state(), before);
        await assert.rejects(f.root.coordinator.request(`/v1/status?work=${foreign.id}`), fail("FORBIDDEN"));
        await t.close();
    }
    finally {
        await f.close();
    }
});
test("next claim is deterministic, atomic, single-current and idempotent", async () => {
    const f = await fixture();
    try {
        await f.add("low", { priority: 1 });
        const high = await f.add("high", { priority: 10 });
        const t = await f.root.tool();
        const first = await t.client.command({ type: "work.claim" }, { id: "claim-once" });
        const second = await t.client.command({ type: "work.claim" }, { id: "claim-once" });
        assert.equal(first.result.execution, second.result.execution);
        assert.equal(first.binding.work, high.id);
        assert.equal(Object.keys(f.state().executions).length, 1);
        await assert.rejects(new Client({ ...f.cfg, token: first.capabilities.worker }).command({ type: "work.plan", changes: [] }), fail("FORBIDDEN"));
        await t.close();
    }
    finally {
        await f.close();
    }
});
test("two roots claiming the same work/environment cannot both win", async () => {
    const f = await fixture();
    try {
        await f.add("only");
        const other = await f.open();
        const a = await f.root.tool(), b = await other.tool();
        const results = await Promise.all([a.client.command({ type: "work.claim" }), b.client.command({ type: "work.claim" })]);
        assert.equal(results.filter(r => r.result.claimed).length, 1);
        assert.equal(results.filter(r => r.result.idle).length, 1);
        assert.equal(Object.keys(f.state().executions).length, 1);
        await a.close();
        await b.close();
    }
    finally {
        await f.close();
    }
});
test("submission releases the work at a tool boundary, not the live process reservation", async () => {
    const f = await fixture();
    try {
        const a = await f.add("A"), b = await f.add("B", { needs: [a.id] });
        const claim = await f.root.tool();
        const c = await claim.client.command({ type: "work.claim" });
        await claim.close();
        const oldTool = await f.root.tool(), doneTool = await f.root.tool();
        await doneTool.worker!.command({ type: "result.submit", summary: "A submitted", manifest: [] });
        await doneTool.close();
        assert.equal(f.state().executions[c.binding.execution]!.state, "active", "parallel tool still holds old binding");
        await oldTool.close();
        assert.equal(f.state().executions[c.binding.execution]!.state, "finished");
        assert.ok(Object.values(f.state().reservations).some(r => r.coordinator && r.state === "active"));
        const next = await f.root.tool();
        const nc = await next.client.command({ type: "work.claim" });
        assert.equal(nc.binding.work, b.id);
        assert.equal(nc.binding.run, c.binding.run, "same root Run can serve multiple work items");
        await assert.rejects(oldTool.worker!.command({ type: "result.submit", summary: "late", manifest: [] }));
        await next.close();
    }
    finally {
        await f.close();
    }
});
test("closed dispatch cannot obtain a newly selected work's capability", async () => {
    const f = await fixture();
    try {
        await f.add("A");
        const t = await f.root.tool();
        await t.client.command({ type: "work.claim" });
        await t.close();
        await assert.rejects(t.client.command({ type: "coordination.credentials" }), fail("STALE_DISPATCH"));
        await assert.rejects(t.client.command({ type: "work.claim" }), fail("STALE_DISPATCH"));
    }
    finally {
        await f.close();
    }
});
test("pending validation is not re-selected without explicit retry and policy is inherited", async () => {
    const f = await fixture(["tests"]);
    try {
        const w = await f.add("Check me");
        assert.deepEqual(f.state().work[w.id]!.policy, { name: "evidence-v1", checks: ["tests"] });
        const t = await f.root.tool();
        await t.client.command({ type: "work.claim" });
        await t.close();
        const done = await f.root.tool();
        await done.worker!.command({ type: "result.submit", summary: "ready for tests", manifest: [{ repo: "test", sha: "a".repeat(40) }] });
        await done.close();
        const next = await f.root.tool();
        assert.equal((await next.client.command({ type: "work.claim" })).result.idle, true);
        assert.equal((await next.client.command({ type: "work.claim", work: w.id, retry: true, reason: "fix failed check" })).binding.work, w.id);
        await next.close();
    }
    finally {
        await f.close();
    }
});
test("grant revocation fences root, dispatch and bootstrap without claiming process termination", async () => {
    const f = await fixture();
    try {
        await f.add("A");
        const t = await f.root.tool();
        const c = await t.client.command({ type: "work.claim" });
        await f.operator.command({ type: "coordination.revoke", grant: f.enable.result.grant, reason: "operator disabled" });
        await assert.rejects(t.client.command({ type: "work.create", title: "bad" }));
        await assert.rejects(new Client({ ...f.cfg, token: c.capabilities.worker }).command({ type: "result.submit", summary: "late" }));
        await assert.rejects(f.open());
        assert.ok(Object.values(f.state().reservations).some(r => r.state === "active"));
    }
    finally {
        await f.close();
    }
});
test("root scope changes are not silently adopted by status/claim", async () => {
    const f = await fixture();
    try {
        await f.add("A");
        await f.operator.command({ type: "work.update", work: f.enable.result.work, description: "New purpose", replan: true });
        await assert.rejects(f.root.coordinator.request("/v1/ready"), fail("STALE_SCOPE"));
    }
    finally {
        await f.close();
    }
});
test("coordinator delegates from runtime root without a fabricated parent Execution", async () => {
    const f = await fixture();
    try {
        const a = await f.add("A");
        const t = await f.root.tool();
        const d = await t.client.command({ type: "delegation.issue", work: a.id, role: "reviewer", mode: "read" });
        await t.close();
        const child = await f.root.adapter.command({ type: "runtime.child", parent: f.root.attached.result.runtimeAgent, externalSessionId: "session", agentId: "child", invocationId: "child-1", environment: "env-A", delegationToken: d.result.token });
        assert.equal(child.binding, undefined);
        assert.ok(child.result.execution);
        assert.equal(Object.keys(f.state().executions).length, 1);
        assert.equal(f.state().executions[child.result.execution]!.parent, null);
        assert.equal(f.state().delegations[d.result.id]!.coordinatorIssuer, f.root.attached.result.coordinator);
    }
    finally {
        await f.close();
    }
});
test("coordinator lifecycle does not turn a window change into a new Run", async () => {
    const f = await fixture();
    try {
        await f.root.runtime.command({ type: "coordination.window", window: "new-window" });
        assert.equal(Object.keys(f.state().runs).length, 1);
        assert.equal(Object.keys(f.state().executions).length, 0);
        await f.root.runtime.command({ type: "coordination.stop", processStopped: false });
        assert.equal(f.state().runs[f.root.attached.result.run]!.state, "unknown");
        await assert.rejects(f.root.coordinator.request("/v1/ready"));
    }
    finally {
        await f.close();
    }
});
test("revoked lifecycle observer may confirm termination but cannot mint new work rights", async () => {
    const f = await fixture();
    try {
        await f.add("A");
        const t = await f.root.tool();
        await t.client.command({ type: "work.claim" });
        await t.close();
        await f.operator.command({ type: "coordination.revoke", grant: f.enable.result.grant, reason: "disable" });
        await f.root.runtime.command({ type: "coordination.stop", processStopped: true });
        assert.ok(Object.values(f.state().reservations).every(r => r.state === "released"));
        await assert.rejects(f.root.runtime.command({ type: "coordination.dispatch", toolId: "new", inputDigest: "new" }));
        await f.root.runtime.command({ type: "coordination.stop", processStopped: false });
        assert.equal(f.state().runs[f.root.attached.result.run]!.state, "ended");
    }
    finally {
        await f.close();
    }
});
test("explicit reenrollment never revives previous coordinator or bootstrap credentials", async () => {
    const f = await fixture();
    try {
        await f.operator.command({ type: "coordination.revoke", grant: f.enable.result.grant, reason: "disable" });
        const again = await f.operator.command({ type: "coordination.enable", repository: "repo-A", environment: "env-A", runtimes: ["harness"], title: "Repository" });
        assert.equal(again.result.work, f.enable.result.work);
        await assert.rejects(f.root.coordinator.request("/v1/status"));
        await assert.rejects(f.open());
        const fresh = await new Client({ ...f.cfg, token: again.bootstrap }).command({ type: "coordination.open", runtime: "harness", environment: "env-A", session: "fresh", actor: "root", invocation: "new" });
        assert.ok(fresh.capabilities.coordinator);
    }
    finally {
        await f.close();
    }
});
test("different devices explicitly enrolling the same repository share scope but not permissions", async () => {
    const f = await fixture(["test"]);
    try {
        const other = new Client({ ...f.cfg, device: "other-device" });
        const reg = await other.command({ type: "coordination.enable", repository: "repo-A", environment: "env-B", runtimes: ["harness"], title: "Other checkout" });
        assert.equal(reg.result.work, f.enable.result.work);
        assert.notEqual(reg.result.grant, f.enable.result.grant);
        await assert.rejects(other.command({ type: "coordination.revoke", grant: f.enable.result.grant, reason: "not mine" }));
        await assert.rejects(other.command({ type: "coordination.enable", repository: "repo-A", environment: "env-B", runtimes: ["harness"], title: "Other", checks: [] }), fail("POLICY_REPLAN_REQUIRED"));
    }
    finally {
        await f.close();
    }
});
test("inherited per-leaf checks survive agent decomposition without weakening explicit parent checks", async () => {
    const f = await fixture(["test"]);
    try {
        const group = await f.add("Feature");
        const t = await f.root.tool();
        const child = (await t.client.command({ type: "work.create", title: "Implement", parent: group.id })).result;
        assert.equal(f.state().work[group.id]!.policy.name, "children-v1");
        assert.deepEqual(f.state().work[child.id]!.policy.checks, ["test"]);
        const explicit = (await f.operator.command({ type: "work.create", title: "Integration contract", parent: f.enable.result.work, policy: { name: "evidence-v1", checks: ["e2e"] } })).result;
        await assert.rejects(t.client.command({ type: "work.create", title: "Bypass", parent: explicit.id }), fail("REPLAN_REQUIRED"));
        await t.close();
    }
    finally {
        await f.close();
    }
});
test("scoped agent can resolve its own declared blocker but not a human hold", async () => {
    const f = await fixture();
    try {
        const w = await f.add("A");
        const t = await f.root.tool();
        const c = await t.client.command({ type: "work.claim" });
        await t.close();
        const block = await f.root.tool();
        const own = await block.worker!.command({ type: "work.report", kind: "blocked", summary: "temporary agent issue" });
        await block.client.command({ type: "work.yield", reason: "wait" });
        await block.close();
        const human = await f.operator.command({ type: "work.report", work: w.id, kind: "blocked", summary: "human decision" });
        const resolve = await f.root.tool();
        await resolve.client.command({ type: "hold.resolve", hold: own.result.hold, reason: "fixed declared issue" });
        await assert.rejects(resolve.client.command({ type: "hold.resolve", hold: human.result.hold, reason: "fake approval" }), fail("FORBIDDEN"));
        assert.equal(f.state().executions[c.binding.execution]!.state, "interrupted");
        await resolve.close();
    }
    finally {
        await f.close();
    }
});
test("scope planning can reprioritize active work but cannot change its requirements", async () => {
    const f = await fixture();
    try {
        const w = await f.add("A");
        const t = await f.root.tool();
        await t.client.command({ type: "work.claim" });
        await t.close();
        const plan = await f.root.tool();
        const version = f.state().work[w.id]!.scopeRevision;
        await plan.client.command({ type: "work.update", work: w.id, priority: 80 });
        assert.equal(f.state().work[w.id]!.scopeRevision, version);
        await assert.rejects(plan.client.command({ type: "work.update", work: w.id, description: "new requirements" }), fail("REPLAN_REQUIRED"));
        await plan.close();
    }
    finally {
        await f.close();
    }
});
test("effect capability is not a process observer and cannot release writer ownership", async () => {
    const f = await fixture();
    try {
        await f.add("A");
        const t = await f.root.tool();
        const c = await t.client.command({ type: "work.claim" });
        const effect = new Client({ ...f.cfg, token: c.capabilities.effect });
        await assert.rejects(effect.command({ type: "runtime.event", execution: c.binding.execution, event: "ended", exitCode: 0 }, { observed: true }), fail("UNAUTHORIZED_OBSERVATION"));
        await assert.rejects(effect.command({ type: "result.submit", summary: "fake" }), fail("FORBIDDEN"));
        await t.close();
    }
    finally {
        await f.close();
    }
});
test("native broker cannot obtain an unscoped worker capability for a Coordinator root", async () => {
    const f = await fixture();
    try {
        await f.add("A");
        const t = await f.root.tool();
        await t.client.command({ type: "work.claim" });
        await t.close();
        await assert.rejects(f.root.adapter.command({ type: "runtime.credentials", agent: f.root.attached.result.runtimeAgent }), fail("TOOL_DISPATCH_REQUIRED"));
    }
    finally {
        await f.close();
    }
});
test("interrupted work requires an intentional retry, not automatic infinite reselection", async () => {
    const f = await fixture();
    try {
        const w = await f.add("Needs repair");
        const claim = await f.root.tool();
        await claim.client.command({ type: "work.claim" });
        await claim.close();
        const stop = await f.root.tool();
        await stop.client.command({ type: "work.yield", reason: "Environment unavailable" });
        await stop.close();
        const ready = await f.root.coordinator.request<any>("/v1/ready");
        assert.equal(ready.ready.length, 0);
        assert.ok(ready.blocked[0].reasons.includes("retry_required"));
        const retry = await f.root.tool();
        await assert.rejects(retry.client.command({ type: "work.claim", retry: true }));
        const result = await retry.client.command({ type: "work.claim", work: w.id, retry: true, reason: "Environment recovered" });
        assert.equal(result.binding.work, w.id);
        assert.equal(Object.keys(f.state().executions).length, 2);
        await retry.close();
    }
    finally {
        await f.close();
    }
});
test("completed tool Git observations remain historical after the same actor claims another work", async () => {
    const f = await fixture();
    try {
        const a = await f.add("A"), b = await f.add("B");
        const claim = await f.root.tool();
        const c = await claim.client.command({ type: "work.claim" });
        await claim.close();
        const old = await f.root.tool();
        const collector = new Client({ ...f.cfg, token: old.dispatch.capabilities.git });
        await old.close();
        const done = await f.root.tool();
        await done.worker!.command({ type: "result.submit", summary: "A", manifest: [] });
        await done.close();
        const next = await f.root.tool();
        assert.equal((await next.client.command({ type: "work.claim" })).binding.work, b.id);
        await next.close();
        const snapshot = { id: "ctx-old", work: a.id, execution: c.binding.execution, scopeRevision: c.binding.scopeRevision, generation: c.binding.generation, repo: "repo", tree: "a".repeat(40), base: null, branch: "feature", capturedAt: new Date().toISOString(), contributors: [] };
        const recorded = await collector.command({ type: "git.commit", snapshot, snapshotDigest: digest(snapshot), commit: { repo: "repo", sha: "b".repeat(40), tree: snapshot.tree, parents: [], subject: "old artifact", author: "test", committer: "test" } }, { observed: true });
        assert.deepEqual(recorded.result.gaps, []);
        assert.equal(f.state().contexts["ctx-old"]!.snapshot.work, a.id);
        assert.equal(f.state().work[b.id]!.candidate, null);
        assert.equal(f.state().executions[c.binding.execution]!.state, "finished");
    }
    finally {
        await f.close();
    }
});
test("coordinator-assigned parallel native children keep own results and survive parent exit as orphans", async () => {
    const f = await fixture();
    try {
        const a = await f.add("Child A"), b = await f.add("Child B");
        for (const environment of ["worktree-A", "worktree-B"])
            await f.operator.command({ type: "coordination.enable", repository: "repo-A", environment, runtimes: ["harness"], title: "Repository" });
        const plan = await f.root.tool();
        const da = await plan.client.command({ type: "delegation.issue", work: a.id, role: "implementer", mode: "write" });
        const db = await plan.client.command({ type: "delegation.issue", work: b.id, role: "implementer", mode: "write" });
        await plan.close();
        const cb = await f.root.adapter.command({ type: "runtime.child", parent: f.root.attached.result.runtimeAgent, externalSessionId: "session", agentId: "B", invocationId: "B1", environment: "worktree-B", delegationToken: db.result.token });
        const ca = await f.root.adapter.command({ type: "runtime.child", parent: f.root.attached.result.runtimeAgent, externalSessionId: "session", agentId: "A", invocationId: "A1", environment: "worktree-A", delegationToken: da.result.token });
        assert.notEqual(ca.result.run, cb.result.run);
        assert.notEqual(ca.result.execution, cb.result.execution);
        const workerA = new Client({ ...f.cfg, token: ca.capabilities.worker }), workerB = new Client({ ...f.cfg, token: cb.capabilities.worker });
        await assert.rejects(workerA.command({ type: "result.submit", work: b.id, summary: "wrong", manifest: [] }), fail("AMBIGUOUS_CONTEXT"));
        await f.root.runtime.command({ type: "coordination.stop", processStopped: true });
        assert.equal(f.state().executions[ca.result.execution]!.state, "active");
        assert.equal(f.state().executions[cb.result.execution]!.state, "active");
        await workerA.command({ type: "result.submit", summary: "A only", manifest: [] });
        await workerB.command({ type: "result.submit", summary: "B only", manifest: [] });
        assert.equal(f.state().work[a.id]!.state, "done");
        assert.equal(f.state().work[b.id]!.state, "done");
        assert.equal(Object.values(f.state().executions).length, 2, "no fake parent execution");
        const tree = await f.operator.request<any>("/v1/runtime");
        assert.equal(tree.nodes.filter((x: any) => x.orphan).length, 2);
    }
    finally {
        await f.close();
    }
});
test("another enrolled device may decompose shared draft work while preserving the same leaf checks", async () => {
    const f = await fixture(["tests"]);
    try {
        const feature = await f.add("Shared draft");
        const otherCfg = { ...f.cfg, device: "second-authorized-device" };
        const other = new Client(otherCfg);
        const reg = await other.command({ type: "coordination.enable", repository: "repo-A", environment: "env-B", runtimes: ["harness"], title: "Repository" });
        const root = await new Client({ ...otherCfg, token: reg.bootstrap }).command({ type: "coordination.open", runtime: "harness", environment: "env-B", session: "second-session", actor: "root", invocation: "second-run" });
        const dispatcher = new Client({ ...otherCfg, token: root.capabilities.runtime });
        const slot = await dispatcher.command({ type: "coordination.dispatch", toolId: "decompose", inputDigest: "new child" });
        const planner = new Client({ ...otherCfg, token: slot.capabilities.coordinator });
        const child = await planner.command({ type: "work.create", parent: feature.id, title: "Implementation" });
        assert.equal(f.state().work[feature.id]!.policy.name, "children-v1");
        assert.deepEqual(f.state().work[child.result.id]!.policy.checks, ["tests"]);
        await dispatcher.command({ type: "coordination.dispatch.close", dispatch: slot.result.dispatch });
    }
    finally {
        await f.close();
    }
});
