import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { startLocal } from "../src/server/local.js";
import { Client } from "../src/cli/client.js";
import { NativeRuntimeBridge, unboundToolEnvironment } from "../src/runtime/native.js";
import { type ContextFile, type Connection, atomic } from "../src/cli/files.js";
import { runtimeView, runtimeMermaid } from "../src/projections/runtime.js";
import { claudeChildGuard } from "../src/runtime/claude-guard.js";
import { uid } from "../src/domain/util.js";
const fail = (code: string) => (error: any) => error.code === code;
async function fixture() {
    const server = await startLocal({ database: ":memory:" });
    const cfg: Connection = { server: server.url, workspace: "local", device: "harness", token: server.secret };
    const operator = new Client(cfg);
    const work = (await operator.command({ type: "work.create", title: "Root scope" })).result;
    const attached = await operator.command({ type: "runtime.attach", work: work.id, runtime: "test-harness", externalSessionId: "conversation", agentId: "root", invocationId: "root-invocation", environment: "root-env" });
    const planner = new Client({ ...cfg, token: attached.capabilities.worker });
    const adapter = new Client({ ...cfg, token: attached.capabilities.adapter });
    const add = async (title: string, extra: Record<string, unknown> = {}) => (await planner.command({ type: "work.create", title, ...extra })).result;
    const delegate = async (workId: string, extra: Record<string, unknown> = {}, issuer = planner) => (await issuer.command({ type: "delegation.issue", work: workId, ...extra })).result;
    const child = async (title: string, options: {
        parent?: string;
        issuer?: Client;
        work?: string;
        role?: string;
        mode?: string;
        session?: string;
    } = {}) => {
        const w = options.work ?? (await add(title)).id;
        const grant = await delegate(w, { role: options.role ?? "implementer", mode: options.mode ?? "write" }, options.issuer);
        const result = await adapter.command({ type: "runtime.child", parent: options.parent ?? attached.result.runtimeAgent, externalSessionId: options.session ?? "conversation", agentId: title, invocationId: `${title}-invocation`, environment: `${title}-env`, delegationToken: grant.token });
        return { ...result, work: w, grant, worker: new Client({ ...cfg, token: result.capabilities.worker }) };
    };
    const observe = (agent: string, event: string, extra: Record<string, unknown> = {}, id = uid("obs")) => adapter.command({ type: "runtime.lifecycle", agent, event, ...extra }, { observed: true, id });
    return { server, cfg, operator, work, attached, planner, adapter, add, delegate, child, observe, state: () => server.workspace.store.snapshot() };
}
test("scoped orchestrator decomposes its own scope without operator privileges", async () => {
    const f = await fixture();
    try {
        const response = await f.planner.command({ type: "work.plan", changes: [{ type: "work.create", title: "A", alias: "a" }, { type: "work.create", title: "B", alias: "b", needs: ["a"] }] });
        const a = response.result.aliases.a, b = response.result.aliases.b, s = f.state();
        assert.equal(s.work[a]!.parent, f.work.id);
        assert.equal(s.work[b]!.parent, f.work.id);
        assert.equal(s.work[f.work.id]!.policy.name, "children-v1");
        assert.equal(s.executions[f.attached.result.execution]!.scopeRevision, s.work[f.work.id]!.scopeRevision);
        await f.planner.command({ type: "work.update", work: a, description: "More detail" });
        await f.planner.command({ type: "dependency.remove", prerequisite: a, dependent: b });
        await f.planner.command({ type: "dependency.add", prerequisite: a, dependent: b });
    }
    finally {
        await f.server.close();
    }
});
test("scoped plan rejects outside work, weakened policy, budget changes and partial batch", async () => {
    const f = await fixture();
    try {
        const foreign = (await f.operator.command({ type: "work.create", title: "Other scope" })).result;
        const own = await f.add("own");
        const commands = [
            { type: "work.create", title: "escape", parent: foreign.id },
            { type: "work.update", work: foreign.id, description: "escape" },
            { type: "work.update", work: own.id, policy: { name: "declaration-v1", checks: [] } },
            { type: "work.update", work: own.id, resources: [] },
            { type: "dependency.add", prerequisite: foreign.id, dependent: own.id },
            { type: "lane.set", lane: "all", capacity: 100 },
            { type: "migration.mode", source: "unknown", mode: "next", confirm: "W1" },
        ];
        for (const command of commands) {
            const before = f.state();
            await assert.rejects(f.planner.command(command));
            assert.deepEqual(f.state(), before);
        }
        const before = f.state();
        await assert.rejects(f.planner.command({ type: "work.plan", changes: [{ type: "work.create", title: "not committed" }, { type: "work.update", work: foreign.id, description: "escape" }] }));
        assert.deepEqual(f.state(), before);
    }
    finally {
        await f.server.close();
    }
});
test("operator replan is not silently adopted by reading status or credentials", async () => {
    const f = await fixture();
    try {
        await f.operator.command({ type: "work.update", work: f.work.id, description: "New contract", replan: true });
        await f.planner.request("/v1/status");
        await assert.rejects(f.planner.command({ type: "work.create", title: "stale child" }), fail("STALE_SCOPE"));
        await assert.rejects(f.adapter.command({ type: "runtime.credentials", agent: f.attached.result.runtimeAgent }), fail("STALE_SCOPE"));
    }
    finally {
        await f.server.close();
    }
});
test("parent cannot replan attempted child or resolve operator hold", async () => {
    const f = await fixture();
    try {
        const a = await f.child("A");
        await assert.rejects(f.planner.command({ type: "work.update", work: a.work, description: "new" }), fail("REPLAN_REQUIRED"));
        const h = (await f.operator.command({ type: "work.report", work: a.work, kind: "blocked", summary: "approval needed" })).result.hold;
        await assert.rejects(f.planner.command({ type: "hold.resolve", hold: h, reason: "I approve" }), fail("FORBIDDEN"));
        await assert.rejects(a.worker.command({ type: "work.create", title: "implementation cannot plan" }), fail("FORBIDDEN"));
        await assert.rejects(f.planner.command({ type: "check.record", result: "none", name: "test", status: "passed", subject: "none" }, { observed: true }), fail("UNAUTHORIZED_OBSERVATION"));
    }
    finally {
        await f.server.close();
    }
});
test("siblings share provider session but have distinct runtime agents, Runs, Executions and results", async () => {
    const f = await fixture();
    try {
        const [wa, wb] = await Promise.all([f.add("A"), f.add("B")]);
        const [a, b] = await Promise.all([f.child("A", { work: wa.id }), f.child("B", { work: wb.id })]);
        assert.notEqual(a.result.runtimeAgent, b.result.runtimeAgent);
        assert.notEqual(a.result.execution, b.result.execution);
        assert.notEqual(a.result.run, b.result.run);
        assert.equal(Object.keys(f.state().sessions).length, 1, "do not fabricate provider conversation IDs");
        assert.equal(f.state().runs[a.result.run]!.parentRun, f.attached.result.run);
        await assert.rejects(a.worker.command({ type: "result.submit", work: b.work, summary: "wrong", manifest: [] }), fail("AMBIGUOUS_CONTEXT"));
        await assert.rejects(a.worker.command({ type: "work.report", work: f.work.id, kind: "progress", summary: "wrong parent" }), fail("AMBIGUOUS_CONTEXT"));
        await Promise.all([a.worker.command({ type: "result.submit", summary: "A done", manifest: [] }), b.worker.command({ type: "result.submit", summary: "B done", manifest: [] })]);
        const s = f.state();
        assert.equal(s.work[f.work.id]!.state, "done");
        assert.equal(Object.values(s.results).find(r => r.execution === a.result.execution)!.work, a.work);
        assert.ok(Object.values(s.reservations).some(r => r.execution === a.result.execution && r.state === "active"), "submitting is not process termination");
    }
    finally {
        await f.server.close();
    }
});
test("runtime child observed without delegation remains unassigned, never falls back to parent", async () => {
    const f = await fixture();
    try {
        const command = { type: "runtime.child", parent: f.attached.result.runtimeAgent, externalSessionId: "conversation", agentId: "unknown", invocationId: "unknown-1" };
        const a = await f.adapter.command(command), b = await f.adapter.command(command);
        assert.equal(a.result.runtimeAgent, b.result.runtimeAgent);
        assert.equal(a.result.execution, null);
        assert.equal(a.capabilities, undefined);
        await assert.rejects(f.adapter.command({ type: "runtime.credentials", agent: a.result.runtimeAgent }), fail("UNBOUND_RUNTIME_ACTOR"));
        assert.equal(Object.keys(f.state().executions).length, 1);
        const v = await f.operator.request<any>("/v1/runtime");
        assert.equal(v.nodes.find((n: any) => n.id === a.result.runtimeAgent).unassigned, true);
    }
    finally {
        await f.server.close();
    }
});
test("child binding is atomic, replay-safe and exact-parent-bound", async () => {
    const f = await fixture();
    try {
        const w = await f.add("A"), grant = await f.delegate(w.id);
        const command = { type: "runtime.child", parent: f.attached.result.runtimeAgent, externalSessionId: "conversation", agentId: "A", invocationId: "A1", environment: "A-env", delegationToken: grant.token };
        const [a, b] = await Promise.all([f.adapter.command(command, { id: "native-spawn-1" }), f.adapter.command(command, { id: "native-spawn-1" })]);
        assert.equal(a.result.execution, b.result.execution);
        const c = await f.adapter.command(command);
        assert.equal(c.result.execution, a.result.execution);
        assert.equal(Object.keys(f.state().executions).length, 2);
        await assert.rejects(f.adapter.command({ ...command, agentId: "thief", invocationId: "thief-1", environment: "other" }), fail("INVALID_DELEGATION"));
        assert.equal(Object.keys(f.state().runtimeAgents).length, 2, "failed claim rolls back observed Run too");
        await assert.rejects(f.adapter.command({ type: "runtime.bind", agent: a.result.runtimeAgent, environment: "changed", delegationToken: grant.token }), fail("RUNTIME_BINDING_CONFLICT"));
    }
    finally {
        await f.server.close();
    }
});
test("parent end leaves child reservations intact and displays orphan; Stop only quiesces", async () => {
    const f = await fixture();
    try {
        const a = await f.child("A");
        await f.observe(a.result.runtimeAgent, "quiescent");
        assert.equal(f.state().executions[a.result.execution]!.state, "active");
        assert.ok(Object.values(f.state().reservations).some(r => r.execution === a.result.execution && r.state === "active"));
        await f.observe(f.attached.result.runtimeAgent, "ended", { exitCode: 0 });
        const v = await f.operator.request<any>("/v1/runtime");
        assert.equal(v.nodes.find((n: any) => n.id === a.result.runtimeAgent).orphan, true);
        assert.equal(v.nodes.find((n: any) => n.id === f.attached.result.runtimeAgent).childrenActive, 1);
        await a.worker.command({ type: "result.submit", summary: "child continues", manifest: [] });
        await f.observe(a.result.runtimeAgent, "ended", { exitCode: 0 });
        assert.equal(f.state().executions[a.result.execution]!.state, "finished");
        assert.ok(Object.values(f.state().reservations).filter(r => r.execution === a.result.execution).every(r => r.state === "released"));
        await f.observe(a.result.runtimeAgent, "unknown");
        assert.equal(f.state().runtimeAgents[a.result.runtimeAgent]!.state, "ended");
    }
    finally {
        await f.server.close();
    }
});
test("grandchildren preserve distinct delegation and runtime ancestry", async () => {
    const f = await fixture();
    try {
        const a = await f.child("A", { role: "orchestrator", mode: "read", session: "child-conversation" });
        const leaf = (await a.worker.command({ type: "work.create", title: "Grandchild work" })).result;
        const grandchild = await f.child("G", { parent: a.result.runtimeAgent, issuer: a.worker, work: leaf.id, session: "grandchild-conversation" });
        const s = f.state(), e = s.executions[grandchild.result.execution]!;
        assert.equal(s.runtimeAgents[grandchild.result.runtimeAgent]!.parent, a.result.runtimeAgent);
        assert.equal(e.parent, a.result.execution);
        assert.equal(s.delegations[e.delegation!]!.parent, a.result.execution);
        assert.equal(e.continuedFrom, null);
        await f.observe(a.result.runtimeAgent, "ended", { exitCode: 0 });
        await grandchild.worker.command({ type: "result.submit", summary: "grandchild done", manifest: [] });
        assert.equal(f.state().work[f.work.id]!.state, "done");
        const runtime = runtimeView(f.state(), { id: "local-owner", device: "harness", role: "operator" });
        assert.match(runtimeMermaid(runtime), /spawned/);
        assert.equal(runtime.nodes.find(n => n.id === grandchild.result.runtimeAgent)!.orphan, true);
    }
    finally {
        await f.server.close();
    }
});
test("rollover keeps identity; resumed root is new Run and never reparents old child", async () => {
    const f = await fixture();
    try {
        const a = await f.child("A");
        await f.observe(f.attached.result.runtimeAgent, "window", { windowId: "window-2" });
        await f.observe(f.attached.result.runtimeAgent, "window", { windowId: "window-2" });
        assert.equal(Object.keys(f.state().runs).length, 2);
        assert.deepEqual(f.state().runs[f.attached.result.run]!.windows, ["window-2"]);
        await f.observe(f.attached.result.runtimeAgent, "ended", { exitCode: 0 });
        const resumed = await f.operator.command({ type: "runtime.attach", work: f.work.id, runtime: "test-harness", externalSessionId: "conversation", agentId: "root", invocationId: "root-resume", environment: "root-env", continuedFrom: f.attached.result.execution });
        assert.notEqual(resumed.result.run, f.attached.result.run);
        assert.equal(f.state().executions[resumed.result.execution]!.continuedFrom, f.attached.result.execution);
        assert.equal(f.state().runtimeAgents[a.result.runtimeAgent]!.parent, f.attached.result.runtimeAgent);
        const resumedAdapter = new Client({ ...f.cfg, token: resumed.capabilities.adapter });
        await assert.rejects(resumedAdapter.command({ type: "runtime.credentials", agent: a.result.runtimeAgent }), fail("FORBIDDEN"));
    }
    finally {
        await f.server.close();
    }
});
test("adapter cannot forge work operations or trusted validation", async () => {
    const f = await fixture();
    try {
        await assert.rejects(f.adapter.command({ type: "work.create", title: "escape" }), fail("FORBIDDEN"));
        await assert.rejects(f.adapter.command({ type: "result.submit", summary: "escape", manifest: [] }), fail("FORBIDDEN"));
        await assert.rejects(f.adapter.command({ type: "check.record", result: "none", name: "ci", subject: "none", status: "passed" }, { observed: true }), fail("UNAUTHORIZED_OBSERVATION"));
        await assert.rejects(f.adapter.request("/v1/snapshot"), fail("FORBIDDEN"));
    }
    finally {
        await f.server.close();
    }
});
test("credential queries do not churn plan revision and stale capabilities are fenced", async () => {
    const f = await fixture();
    try {
        const a = await f.child("A"), revision = f.state().meta.revision;
        await f.adapter.command({ type: "runtime.credentials", agent: a.result.runtimeAgent });
        assert.equal(f.state().meta.revision, revision);
        await f.operator.command({ type: "execution.recover", execution: a.result.execution, stopped: true, reason: "confirmed stopped" });
        await assert.rejects(a.worker.request("/v1/status"), fail("FENCED_EXECUTION"));
        await assert.rejects(f.adapter.command({ type: "runtime.credentials", agent: a.result.runtimeAgent }));
    }
    finally {
        await f.server.close();
    }
});
function cli(args: string[], env: NodeJS.ProcessEnv, input = ""): Promise<{
    code: number;
    stdout: string;
    stderr: string;
}> {
    return new Promise((resolvePromise, reject) => {
        const child = spawn(process.execPath, [resolve("dist/src/cli/main.js"), ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
        let stdout = "", stderr = "";
        child.stdout.on("data", b => stdout += b);
        child.stderr.on("data", b => stderr += b);
        child.once("error", reject);
        child.once("close", code => resolvePromise({ code: code ?? 1, stdout, stderr }));
        child.stdin.end(input);
    });
}
test("native broker supplies independent tool contexts and prevents operator fallback", async () => {
    const server = await startLocal({ database: ":memory:" }), home = mkdtempSync(join(tmpdir(), "wr-native-tools-"));
    try {
        const cfg = { server: server.url, workspace: "local", device: "bridge", token: server.secret };
        atomic(join(home, "connection.json"), cfg); // deliberately tempting operator fallback
        const operator = new Client(cfg), w = (await operator.command({ type: "work.create", title: "native root" })).result;
        const bridge = await NativeRuntimeBridge.attach(cfg, { work: w.id, runtime: "test-harness", externalSessionId: "session", agentId: "root", invocationId: "root", environment: "parent" }, "attach-once", join(home, "native"));
        const base = { ...process.env, WR_NEXT_HOME: home, WR_NEXT_CONTEXT: "/bogus/parent-context", WR_NEXT_TOKEN: cfg.token, WR_NEXT_RUNTIME_CONNECTION: "/parent-collector" };
        const rootEnv = await bridge.toolEnvironment(bridge.root, base);
        const rootCtx = JSON.parse(readFileSync(rootEnv.WR_NEXT_CONTEXT!, "utf8")) as ContextFile;
        const planner = new Client(rootCtx);
        const children = (await planner.command({ type: "work.plan", changes: [{ type: "work.create", title: "A" }, { type: "work.create", title: "B" }] })).result.changes;
        const actors = [];
        for (const [i, child] of children.entries()) {
            const ticket = (await planner.command({ type: "delegation.issue", work: child.id })).result;
            actors.push(await bridge.childStarted(bridge.root, { externalSessionId: "session", agentId: `child-${i}`, invocationId: `child-${i}` }, `start-${i}`, { delegationToken: ticket.token, environment: `env-${i}` }));
        }
        const environments = await Promise.all(actors.map(a => bridge.toolEnvironment(a.runtimeAgent, base)));
        assert.notEqual(environments[0]!.WR_NEXT_CONTEXT, environments[1]!.WR_NEXT_CONTEXT);
        for (const env of environments) {
            assert.equal(env.WR_NEXT_TOKEN, undefined);
            assert.equal(env.WR_NEXT_RUNTIME_CONNECTION, undefined);
            assert.equal(lstatSync(env.WR_NEXT_CONTEXT!).mode & 0o077, 0);
        }
        const submitted = await Promise.all(environments.map((env, i) => cli(["done", "--summary", `done-${i}`], env)));
        for (const r of submitted)
            assert.equal(r.code, 0, r.stderr);
        assert.equal(server.workspace.store.snapshot().work[w.id]!.state, "done");
        const denied = await cli(["done", "--summary", "wrong parent"], unboundToolEnvironment(base));
        assert.notEqual(denied.code, 0);
        assert.match(denied.stderr, /UNBOUND_RUNTIME_ACTOR/);
        const mismatch = await cli(["report", "--progress", "wrong"], { ...environments[0], WR_NEXT_RUNTIME_AGENT: actors[1]!.runtimeAgent });
        assert.notEqual(mismatch.code, 0);
        assert.match(mismatch.stderr, /UNBOUND_RUNTIME_ACTOR/);
        const agents = await cli(["agents", "--format", "mermaid"], rootEnv);
        assert.equal(agents.code, 0, agents.stderr);
        assert.match(agents.stdout, /runtime hierarchy/);
    }
    finally {
        await server.close();
        rmSync(home, { recursive: true, force: true });
    }
});
test("Claude wrapper denies unbound native tools before touching inherited parent credentials", async () => {
    const input = { hook_event_name: "PreToolUse", session_id: "shared", agent_id: "native-child", tool_name: "Bash", tool_input: { command: "wr-next done --summary unsafe" } };
    const out = await cli(["internal", "runtime-event"], { ...process.env, WR_NEXT_CONTEXT: "/nonexistent-parent", WR_NEXT_RUNTIME_CONNECTION: "/nonexistent-parent-connection" }, JSON.stringify(input));
    assert.equal(out.code, 0);
    assert.equal(JSON.parse(out.stdout).hookSpecificOutput.permissionDecision, "deny");
    assert.equal(claudeChildGuard({ hook_event_name: "PreToolUse" }), null);
    assert.deepEqual(claudeChildGuard({ hook_event_name: "PostToolUse", agent_id: "child" }), {});
    assert.deepEqual(claudeChildGuard({ hook_event_name: "SubagentStop", agent_id: "child" }), {});
});
test("decomposing an unattempted evidence child cannot weaken its operator policy", async () => {
    const f = await fixture();
    try {
        const child = (await f.operator.command({ type: "work.create", title: "protected child", parent: f.work.id, replan: true, policy: { name: "evidence-v1", checks: ["independent"] } })).result;
        // Operator replan intentionally stales the original coordinator. Attach a fresh
        // read-only coordinator after explicitly stopping that old attempt.
        await f.operator.command({ type: "execution.recover", execution: f.attached.result.execution, stopped: true, reason: "replace coordinator" });
        const start = await f.operator.command({ type: "execution.start", work: f.work.id, role: "orchestrator", mode: "read", environment: "new", launchId: "new" });
        const planner = new Client({ ...f.cfg, token: start.capabilities.worker });
        const before = f.state();
        await assert.rejects(planner.command({ type: "work.create", title: "bypass", parent: child.id }), fail("REPLAN_REQUIRED"));
        assert.deepEqual(f.state(), before);
    }
    finally {
        await f.server.close();
    }
});
test("scoped child inherits lane and concurrent native claims honor capacity", async () => {
    const f = await fixture();
    try {
        await f.operator.command({ type: "lane.set", lane: "workers", capacity: 1 });
        await f.operator.command({ type: "execution.recover", execution: f.attached.result.execution, stopped: true, reason: "configure scope" });
        await f.operator.command({ type: "work.update", work: f.work.id, lane: "workers" });
        const attached = await f.operator.command({ type: "runtime.attach", work: f.work.id, runtime: "test-harness", externalSessionId: "conversation", agentId: "root", invocationId: "lane-root", environment: "root-env" });
        const planner = new Client({ ...f.cfg, token: attached.capabilities.worker }), adapter = new Client({ ...f.cfg, token: attached.capabilities.adapter });
        const works = [];
        for (const name of ["A", "B"])
            works.push((await planner.command({ type: "work.create", title: name })).result);
        for (const w of works)
            assert.equal(f.state().work[w.id]!.lane, "workers");
        const commands = [];
        for (const w of works) {
            const grant = (await planner.command({ type: "delegation.issue", work: w.id })).result;
            commands.push({ type: "runtime.child", parent: attached.result.runtimeAgent, externalSessionId: "conversation", agentId: w.key, invocationId: w.key, environment: w.key, delegationToken: grant.token });
        }
        const attempts = await Promise.allSettled(commands.map(c => adapter.command(c)));
        assert.equal(attempts.filter(x => x.status === "fulfilled").length, 1);
        assert.equal(attempts.filter(x => x.status === "rejected").length, 1);
    }
    finally {
        await f.server.close();
    }
});
test("out-of-order native observations cannot overwrite a newer quiescent state", async () => {
    const f = await fixture();
    try {
        const a = await f.child("A");
        await f.observe(a.result.runtimeAgent, "quiescent", { sequence: 10 });
        await f.observe(a.result.runtimeAgent, "started", { sequence: 9 });
        assert.equal(f.state().runtimeAgents[a.result.runtimeAgent]!.state, "quiescent");
        assert.equal(f.state().runtimeAgents[a.result.runtimeAgent]!.lastSequence, 10);
        await f.observe(a.result.runtimeAgent, "ended", { sequence: 11, exitCode: 0 });
        await f.observe(a.result.runtimeAgent, "heartbeat", { sequence: 12 });
        assert.equal(f.state().runtimeAgents[a.result.runtimeAgent]!.state, "ended");
    }
    finally {
        await f.server.close();
    }
});
test("native root cannot be observed as its own child", async () => {
    const f = await fixture();
    try {
        await assert.rejects(f.adapter.command({ type: "runtime.child", parent: f.attached.result.runtimeAgent, externalSessionId: "conversation", agentId: "root", invocationId: "root-invocation" }), fail("RUNTIME_BINDING_CONFLICT"));
        assert.equal(Object.keys(f.state().runtimeAgents).length, 1);
    }
    finally {
        await f.server.close();
    }
});
test("wrapper refuses unsupported native spawn rather than claiming full Claude support", () => {
    for (const name of ["Agent", "Task"])
        assert.equal((claudeChildGuard({ hook_event_name: "PreToolUse", tool_name: name }) as any).hookSpecificOutput.permissionDecision, "deny");
    assert.equal(claudeChildGuard({ hook_event_name: "PreToolUse", tool_name: "Bash" }), null);
});
test("broker preserves an observed unassigned child when revoked work binding fails, and restores after parent exit", async () => {
    const server = await startLocal({ database: ":memory:" }), dir = mkdtempSync(join(tmpdir(), "wr-native-recovery-"));
    try {
        const cfg: Connection = { server: server.url, workspace: "local", device: "broker", token: server.secret };
        const operator = new Client(cfg), work = (await operator.command({ type: "work.create", title: "root" })).result;
        const bridge = await NativeRuntimeBridge.attach(cfg, { work: work.id, runtime: "test-harness", externalSessionId: "session", agentId: "root", invocationId: "root", environment: "root" }, "root-once", dir);
        const env = await bridge.toolEnvironment(bridge.root, {});
        const planner = new Client(JSON.parse(readFileSync(env.WR_NEXT_CONTEXT!, "utf8")) as ContextFile);
        const child = (await planner.command({ type: "work.create", title: "child" })).result;
        const rejected = (await planner.command({ type: "delegation.issue", work: child.id })).result;
        await planner.command({ type: "delegation.revoke", delegation: rejected.id, reason: "retracted" });
        const identity = { externalSessionId: "session", agentId: "child", invocationId: "child-start" };
        await assert.rejects(bridge.childStarted(bridge.root, identity, "observe-once", { delegationToken: rejected.token, environment: "child" }), fail("INVALID_DELEGATION"));
        const observed = Object.values(server.workspace.store.snapshot().runtimeAgents).find(a => a.externalAgentId === "child")!;
        assert.equal(observed.execution, null);
        const valid = (await planner.command({ type: "delegation.issue", work: child.id })).result;
        await bridge.bind(observed.id, valid.token, "child", "bind-valid");
        await bridge.lifecycle(bridge.root, "ended", "root-ended", { exitCode: 0 });
        const restored = await NativeRuntimeBridge.restore(join(dir, bridge.root, "broker.json"));
        const childEnv = await restored.toolEnvironment(observed.id, {});
        const childClient = new Client(JSON.parse(readFileSync(childEnv.WR_NEXT_CONTEXT!, "utf8")) as ContextFile);
        await childClient.command({ type: "result.submit", summary: "orphan can finish", manifest: [] });
        await restored.lifecycle(observed.id, "ended", "child-ended", { exitCode: 0 });
        assert.equal(server.workspace.store.snapshot().work[work.id]!.state, "done");
    }
    finally {
        await server.close();
        rmSync(dir, { recursive: true, force: true });
    }
});
