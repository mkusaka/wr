import { test } from "bun:test";
import assert from "node:assert/strict";
import { LocalSql } from "../src/server/local-sql.js";
import { Store } from "../src/server/store.js";
import { Workspace } from "../src/domain/service.js";
import { emptyState, tables, type Principal } from "../src/domain/model.js";
import { digest } from "../src/domain/util.js";
import { envelope } from "../src/protocol/validate.js";
import { Tokens } from "../src/server/auth.js";
test("v1 storage migrates without inventing native lineage or deleting historical records", () => {
    const sql = new LocalSql(":memory:");
    try {
        sql.execute("CREATE TABLE schema_versions (version INTEGER PRIMARY KEY)");
        sql.execute("INSERT INTO schema_versions VALUES(1)");
        for (const table of tables.filter(t => t !== "runtimeAgents"))
            sql.execute(`CREATE TABLE ${table} (id TEXT PRIMARY KEY, body TEXT NOT NULL CHECK(json_valid(body)))`);
        sql.execute("CREATE TABLE metadata (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL)");
        sql.execute("INSERT INTO metadata VALUES(1,?)", JSON.stringify(emptyState().meta));
        sql.execute("CREATE TABLE operations (principal TEXT NOT NULL,id TEXT NOT NULL,request_hash TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(principal,id))");
        const legacySession = { id: "old-session", runtime: "claude", externalId: "raw-session", device: "device" };
        sql.execute("INSERT INTO sessions VALUES(?,?)", legacySession.id, JSON.stringify(legacySession));
        const s = new Store(sql);
        assert.deepEqual(s.snapshot().sessions[legacySession.id], legacySession);
        assert.deepEqual(s.snapshot().runtimeAgents, {});
        assert.equal(sql.all<{
            version: number;
        }>("SELECT MAX(version) AS version FROM schema_versions")[0]!.version, 2);
        assert.deepEqual(new Store(sql).snapshot(), s.snapshot(), "reopening migration is idempotent");
    }
    finally {
        sql.close();
    }
});
test("legacy operation receipts fail visibly rather than re-executing with weaker fingerprints", () => {
    const sql = new LocalSql(":memory:");
    try {
        const store = new Store(sql), ws = new Workspace(store), p: Principal = { id: "user", device: "device", role: "operator" };
        const command = { type: "work.create", title: "legacy" };
        const oldHash = digest({ command, observed: false, role: "operator" });
        sql.execute("INSERT INTO operations VALUES(?,?,?,?)", p.id, "old-operation", oldHash, JSON.stringify({ result: { id: "old-result" } }));
        assert.throws(() => ws.execute(envelope({ schemaVersion: 1, operationId: "old-operation", command }), p), (error: any) => error.code === "LEGACY_OPERATION_REPLAY");
        assert.equal(Object.keys(store.snapshot().work).length, 0);
        assert.equal(sql.all<{
            count: number;
        }>("SELECT COUNT(*) AS count FROM operations")[0]!.count, 1);
    }
    finally {
        sql.close();
    }
});
test("capability signatures include generation and native actor scope", () => {
    const tokens = new Tokens("s".repeat(64), "workspace");
    const p: Principal = { id: "user", device: "device", role: "worker", execution: "exec", generation: 4, runtimeAgent: "agent" };
    assert.deepEqual(tokens.read(tokens.mint(p)), p);
    const adapter: Principal = { id: "user", device: "device", role: "adapter", generation: 2, runtimeRoot: "root" };
    assert.deepEqual(tokens.read(tokens.mint(adapter)), adapter);
});
