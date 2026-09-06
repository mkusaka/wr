import { test } from "bun:test";
import assert from "node:assert/strict";
import { startLocal } from "../src/server/local.js";
import { Client } from "../src/cli/client.js";
import { Tokens } from "../src/server/auth.js";
import { uid } from "../src/domain/util.js";
import cloudflare, { WorkspaceDO, type Env } from "../src/server/cloudflare.js";
import { LocalSql } from "../src/server/local-sql.js";
test("HTTP rejects bad auth, cross-origin and wrong workspace", async () => {
    const s = await startLocal({ database: ":memory:" });
    try {
        const cfg = { server: s.url, workspace: "local", device: "test", token: s.secret };
        const c = new Client(cfg);
        await c.command({ type: "work.create", title: "one" });
        await assert.rejects(new Client({ ...cfg, token: "bad" }).request("/v1/status"));
        await assert.rejects(new Client({ ...cfg, workspace: "other" }).request("/v1/status"));
        const r = await fetch(`${s.url}/v1/status`, { headers: { authorization: `Bearer ${s.secret}`, "x-wr-next-workspace": "local", origin: "https://evil.invalid" } });
        assert.equal(r.status, 403);
    }
    finally {
        await s.close();
    }
});
test("HTTP simultaneous starts produce exactly one execution", async () => {
    const s = await startLocal({ database: ":memory:" });
    try {
        const c = new Client({ server: s.url, workspace: "local", device: "test", token: s.secret });
        const w = await c.command({ type: "work.create", title: "one" });
        const starts = await Promise.allSettled([1, 2].map(i => c.command({ type: "execution.start", work: w.result.id, environment: "same", launchId: `l${i}` })));
        assert.equal(starts.filter(x => x.status === "fulfilled").length, 1);
        assert.equal(Object.keys(s.workspace.store.snapshot().executions).length, 1);
    }
    finally {
        await s.close();
    }
});
test("worker capability cannot mint collectors or read another scope", async () => {
    const s = await startLocal({ database: ":memory:" });
    try {
        const cfg = { server: s.url, workspace: "local", device: "test", token: s.secret };
        const c = new Client(cfg);
        const a = await c.command({ type: "work.create", title: "a" }), b = await c.command({ type: "work.create", title: "b" });
        const e = await c.command({ type: "execution.start", work: a.result.id, environment: "a", launchId: "a" });
        const worker = new Client({ ...cfg, token: e.capabilities.worker });
        await assert.rejects(worker.request("/v1/capabilities", { checks: ["test"] }));
        await assert.rejects(worker.request(`/v1/status?work=${b.result.id}`));
        const r = await worker.request<any>("/v1/status");
        assert.equal(r.items.length, 1);
        assert.equal(r.items[0].id, a.result.id);
    }
    finally {
        await s.close();
    }
});
test("capabilities are signed, expiring and bound to a workspace", () => { const t = new Tokens("s".repeat(64), "one"); const token = t.mint({ id: "user", device: "d", role: "operator" }); assert.equal(t.read(token).id, "user"); assert.throws(() => new Tokens("s".repeat(64), "two").read(token)); assert.throws(() => t.read(token.slice(0, -1) + "!")); assert.throws(() => t.read(t.mint({ id: "u", device: "d", role: "operator" }, -1))); });
test("Cloudflare adapter uses the same SQL and authentication contract", async () => {
    const sql = new LocalSql(":memory:"), secret = "s".repeat(64);
    const ctx = { storage: { sql: { exec<T extends Record<string, unknown>>(q: string, ...b: (string | number | null)[]): Iterable<T> {
                    if (/^SELECT/i.test(q))
                        return sql.all<T>(q, ...b);
                    sql.execute(q, ...b);
                    return [];
                } }, transactionSync: <T>(fn: () => T) => sql.transaction(fn) } };
    const tokens = new Tokens(secret, "test"), principal = { id: "user", device: "d", role: "operator" as const };
    let target: WorkspaceDO;
    const env: Env = { SIGNING_SECRET: secret, ACCESS_ISSUER: "https://example.cloudflareaccess.com", ACCESS_AUDIENCE: "test", WORKSPACE_MEMBERS: JSON.stringify({ test: ["user"] }), WORKSPACES: { idFromName: name => name, get: () => ({ fetch: r => target.fetch(r) }) } };
    target = new WorkspaceDO(ctx, env);
    try {
        const req = new Request("https://wr-next.example/v1/commands", { method: "POST", headers: { authorization: `Bearer ${tokens.mint(principal)}`, "x-wr-next-workspace": "test", "content-type": "application/json" }, body: JSON.stringify({ schemaVersion: 1, operationId: uid("op"), command: { type: "work.create", title: "through DO" } }) });
        const res = await cloudflare.fetch(req, env);
        assert.equal(res.status, 200);
        assert.equal((await res.json() as any).result.key, "W1");
        const denied = new Request("https://wr-next.example/v1/status", { headers: { authorization: `Bearer ${tokens.mint({ ...principal, id: "stranger" })}`, "x-wr-next-workspace": "test" } });
        assert.equal((await cloudflare.fetch(denied, env)).status, 403);
    }
    finally {
        sql.close();
    }
});
