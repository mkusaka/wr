import { test } from "bun:test";
import assert from "node:assert/strict";
import { LocalSql } from "../src/server/local-sql.js";
import { Store } from "../src/server/store.js";
import { Workspace } from "../src/domain/service.js";
import { envelope } from "../src/protocol/validate.js";
import { uid } from "../src/domain/util.js";
import type { Principal } from "../src/domain/model.js";
import { startLocal } from "../src/server/local.js";
import { Client } from "../src/cli/client.js";
const owner: Principal = { id: "user", device: "device", role: "operator" };
function fixture() {
    const sql = new LocalSql(":memory:"), ws = new Workspace(new Store(sql));
    const cmd = (command: unknown, p = owner, observed = false, id = uid("op")): any => ws.execute(envelope({ schemaVersion: 1, operationId: id, command }), p, observed);
    const add = (title = "work", extra: Record<string, unknown> = {}) => cmd({ type: "work.create", title, ...extra }).result;
    const start = (work: string, extra: Record<string, unknown> = {}) => cmd({ type: "execution.start", work, environment: uid("env"), launchId: uid("launch"), ...extra }).result;
    const actor = (execution: string, role: Principal["role"] = "worker"): Principal => ({ ...owner, role, execution, generation: ws.store.snapshot().executions[execution]!.generation } as Principal);
    return { sql, ws, cmd, add, start, actor, state: () => ws.store.snapshot() };
}
function denied(f: () => unknown, code?: string) { assert.throws(f, (e: any) => code ? e.code === code : typeof e.code === "string"); }
test("collector cannot submit results, clear a hold, or end a runtime", () => {
    const f = fixture();
    try {
        const w = f.add(), e = f.start(w.id), collector = { ...f.actor(e.execution, "collector"), checks: ["git:*"] };
        const hold = f.cmd({ type: "work.report", kind: "blocked", summary: "waiting" }, f.actor(e.execution)).result.hold;
        const before = f.state();
        denied(() => f.cmd({ type: "result.submit", summary: "fake", manifest: [] }, collector), "FORBIDDEN");
        denied(() => f.cmd({ type: "hold.resolve", hold, reason: "fake" }, collector), "FORBIDDEN");
        denied(() => f.cmd({ type: "runtime.event", execution: e.execution, event: "ended", exitCode: 0 }, collector, true), "UNAUTHORIZED_OBSERVATION");
        assert.deepEqual(f.state(), before);
    }
    finally {
        f.sql.close();
    }
});
test("launcher cannot impersonate a worker to submit a result", () => {
    const f = fixture();
    try {
        const e = f.start(f.add().id);
        denied(() => f.cmd({ type: "result.submit", summary: "fake", manifest: [] }, f.actor(e.execution, "launcher")), "FORBIDDEN");
    }
    finally {
        f.sql.close();
    }
});
test("ended parent cannot redeem an outstanding delegation", () => {
    const f = fixture();
    try {
        const parent = f.add(), child = f.add("child", { parent: parent.id }), e = f.start(parent.id, { role: "orchestrator", mode: "read" });
        const p = f.actor(e.execution), ticket = f.cmd({ type: "delegation.issue", work: child.id }, p).result;
        f.cmd({ type: "runtime.event", execution: e.execution, event: "ended", exitCode: 0 }, f.actor(e.execution, "launcher"), true);
        denied(() => f.cmd({ type: "execution.start", work: child.id, environment: "child", launchId: "child", delegationToken: ticket.token }, p), "INVALID_DELEGATION");
        assert.equal(Object.keys(f.state().executions).length, 1);
    }
    finally {
        f.sql.close();
    }
});
test("delegation freezes role and mode; worker cannot elevate itself", () => {
    const f = fixture();
    try {
        const parent = f.add(), child = f.add("child", { parent: parent.id }), e = f.start(parent.id, { role: "orchestrator", mode: "read" });
        const p = f.actor(e.execution), ticket = f.cmd({ type: "delegation.issue", work: child.id, role: "reviewer", mode: "read" }, p).result;
        denied(() => f.cmd({ type: "execution.start", work: child.id, environment: "child", launchId: "child", delegationToken: ticket.token, role: "orchestrator", mode: "write" }, p), "INVALID_DELEGATION");
        const accepted = f.cmd({ type: "execution.start", work: child.id, environment: "child", launchId: "child", delegationToken: ticket.token }, p).result;
        assert.equal(f.state().executions[accepted.execution]!.role, "reviewer");
        assert.equal(f.state().executions[accepted.execution]!.mode, "read");
    }
    finally {
        f.sql.close();
    }
});
test("revoked, expired or replanned child grants cannot start work", () => {
    for (const reason of ["revoked", "expired", "replanned"] as const) {
        const f = fixture();
        try {
            const parent = f.add(), child = f.add("child", { parent: parent.id }), e = f.start(parent.id, { role: "orchestrator", mode: "read" });
            const p = f.actor(e.execution), d = f.cmd({ type: "delegation.issue", work: child.id }, p).result;
            if (reason === "revoked")
                f.cmd({ type: "delegation.revoke", delegation: d.id, reason: "changed" }, p);
            if (reason === "expired") {
                const a = f.state(), b = structuredClone(a);
                b.delegations[d.id]!.expiresAt = "2000-01-01T00:00:00.000Z";
                f.ws.store.save(a, b);
            }
            if (reason === "replanned")
                f.cmd({ type: "work.update", work: child.id, description: "new requirements" });
            denied(() => f.cmd({ type: "execution.start", work: child.id, environment: "child", launchId: "child", delegationToken: d.token }, p), "INVALID_DELEGATION");
        }
        finally {
            f.sql.close();
        }
    }
});
test("late unknown observations never resurrect an ended run", () => {
    const f = fixture();
    try {
        const e = f.start(f.add().id), launcher = f.actor(e.execution, "launcher");
        f.cmd({ type: "runtime.event", execution: e.execution, event: "ended", exitCode: 0 }, launcher, true);
        f.cmd({ type: "runtime.event", execution: e.execution, event: "unknown" }, launcher, true);
        assert.equal(f.state().runs[e.run]!.state, "ended");
    }
    finally {
        f.sql.close();
    }
});
test("run start and session observation reuse one provider session", () => {
    const f = fixture();
    try {
        const e = f.start(f.add().id, { runtime: "claude", session: "provider-session" });
        f.cmd({ type: "runtime.event", execution: e.execution, event: "started", externalSessionId: "provider-session" }, f.actor(e.execution, "launcher"), true);
        assert.equal(Object.keys(f.state().sessions).length, 1);
    }
    finally {
        f.sql.close();
    }
});
test("cancelled aggregate cannot be started as an orchestrator", () => {
    const f = fixture();
    try {
        const p = f.add();
        f.add("child", { parent: p.id });
        f.cmd({ type: "work.cancel", work: p.id, reason: "cancel" });
        denied(() => f.start(p.id, { role: "orchestrator", mode: "read" }), "NOT_READY");
    }
    finally {
        f.sql.close();
    }
});
test("ended worker cannot clear its old hold", () => {
    const f = fixture();
    try {
        const e = f.start(f.add().id), worker = f.actor(e.execution);
        const h = f.cmd({ type: "work.report", kind: "blocked", summary: "waiting" }, worker).result.hold;
        f.cmd({ type: "runtime.event", execution: e.execution, event: "ended", exitCode: 0 }, f.actor(e.execution, "launcher"), true);
        denied(() => f.cmd({ type: "hold.resolve", hold: h, reason: "late" }, worker), "FENCED_EXECUTION");
    }
    finally {
        f.sql.close();
    }
});
test("stopped execution start replay cannot mint new capabilities", async () => {
    const s = await startLocal({ database: ":memory:" });
    try {
        const c = new Client({ server: s.url, workspace: "local", device: "test", token: s.secret });
        const w = (await c.command({ type: "work.create", title: "work" })).result;
        const command = { type: "execution.start", work: w.id, environment: "env", launchId: "launch" };
        const e = (await c.command(command, { id: "start-once" })).result;
        await c.command({ type: "execution.recover", execution: e.execution, stopped: true, reason: "stopped" });
        await assert.rejects(c.command(command, { id: "start-once" }), (error: any) => error.code === "FENCED_EXECUTION");
        assert.equal(Object.keys(s.workspace.store.snapshot().executions).length, 1);
    }
    finally {
        await s.close();
    }
});
