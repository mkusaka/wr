import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { startLocal } from "../src/server/local.js";
import { Client, enqueue, syncOutbox, pendingCount } from "../src/cli/client.js";
import { atomic, type Connection } from "../src/cli/files.js";
import { runWork as launch } from "../src/cli/run.js";
import { uid } from "../src/domain/util.js";
const cli = resolve("dist/src/cli/main.js");
function run(args: string[], env = process.env): Promise<{
    code: number;
    stdout: string;
    stderr: string;
}> { return new Promise((resolve, reject) => { const child = spawn(process.execPath, [cli, ...args], { env, stdio: ["ignore", "pipe", "pipe"] }); let stdout = "", stderr = ""; child.stdout.on("data", b => stdout += b); child.stderr.on("data", b => stderr += b); child.on("error", reject); child.on("close", code => resolve({ code: code ?? 1, stdout, stderr })); }); }
async function fixture() {
    const home = mkdtempSync(join(tmpdir(), "wr-next-runtime-")), old = process.env.WR_NEXT_HOME, oldCtx = process.env.WR_NEXT_CONTEXT;
    process.env.WR_NEXT_HOME = home;
    delete process.env.WR_NEXT_CONTEXT;
    const server = await startLocal({ database: join(home, "db.sqlite") });
    const cfg: Connection = { server: server.url, workspace: "local", device: "runtime-test", token: server.secret };
    atomic(join(home, "connection.json"), cfg);
    return { home, server, cfg, client: new Client(cfg), close: async () => {
            await server.close();
            rmSync(home, { recursive: true, force: true });
            if (old === undefined)
                delete process.env.WR_NEXT_HOME;
            else
                process.env.WR_NEXT_HOME = old;
            if (oldCtx === undefined)
                delete process.env.WR_NEXT_CONTEXT;
            else
                process.env.WR_NEXT_CONTEXT = oldCtx;
        } };
}
test("CLI and fake child use current work without internal IDs", async () => {
    const f = await fixture();
    try {
        const created = await run(["add", "work"]);
        assert.equal(created.code, 0, created.stderr);
        const key = JSON.parse(created.stdout).result.key;
        const out = await run(["run", key, "--", process.execPath, resolve("dist/examples/fake-agent.js")]);
        assert.equal(out.code, 0, out.stderr);
        const v = await f.client.request<any>("/v1/status");
        assert.equal(v.items[0].state, "done");
        assert.equal(v.running.length, 0);
        const launches = readdirSync(join(f.home, "launches"));
        assert.equal(launches.length, 1);
        const receipt = JSON.parse(readFileSync(join(f.home, "launches", launches[0]!, "receipt.json"), "utf8"));
        assert.equal(receipt.state, "ended");
        assert.ok(receipt.process.startIdentity);
    }
    finally {
        await f.close();
    }
});
test("exit zero without a submission leaves work open", async () => {
    const f = await fixture();
    try {
        const w = await f.client.command({ type: "work.create", title: "not submitted" });
        const result = await launch(f.cfg, { work: w.result.id, argv: [process.execPath, "-e", "process.exit(0)"], cwd: f.home });
        assert.equal(result.exitCode, 0);
        const s = f.server.workspace.store.snapshot();
        assert.equal(s.work[w.result.id]!.state, "open");
        assert.equal(s.executions[result.execution]!.state, "interrupted");
    }
    finally {
        await f.close();
    }
});
test("submitted result does not release a still-running writer", async () => {
    const f = await fixture();
    try {
        const w = await f.client.command({ type: "work.create", title: "alive after done" });
        const code = `const {spawnSync}=require('node:child_process');const r=spawnSync('wr-next',['done','--summary','submitted'],{encoding:'utf8'});if(r.status)process.exit(r.status);require('node:fs').writeFileSync(${JSON.stringify(join(f.home, "submitted"))},'ok');setTimeout(()=>{},800);`;
        const pending = launch(f.cfg, { work: w.result.id, argv: [process.execPath, "-e", code], cwd: f.home });
        for (let i = 0; i < 100 && !existsSync(join(f.home, "submitted")); i++)
            await new Promise(r => setTimeout(r, 15));
        assert.ok(existsSync(join(f.home, "submitted")));
        let s = f.server.workspace.store.snapshot();
        assert.equal(s.work[w.result.id]!.state, "done");
        assert.equal(Object.values(s.reservations).filter(r => r.state === "active").length, 1);
        await pending;
        s = f.server.workspace.store.snapshot();
        assert.equal(Object.values(s.reservations).filter(r => r.state === "active").length, 0);
    }
    finally {
        await f.close();
    }
});
test("spawn error is recorded and reserved resources are recovered", async () => {
    const f = await fixture();
    try {
        const w = await f.client.command({ type: "work.create", title: "missing command" });
        const r = await launch(f.cfg, { work: w.result.id, argv: [join(f.home, "not-installed")], cwd: f.home });
        assert.equal(r.exitCode, 127);
        const s = f.server.workspace.store.snapshot();
        assert.equal(s.executions[r.execution]!.state, "failed");
        assert.equal(Object.values(s.reservations).filter(r => r.state === "active").length, 0);
    }
    finally {
        await f.close();
    }
});
test("offline outbox replays idempotently, conflicts remain quarantined", async () => {
    const f = await fixture();
    try {
        const w = await f.client.command({ type: "work.create", title: "queue" });
        const operationId = uid("offline");
        const message = { schemaVersion: 1, operationId, command: { type: "work.report", work: w.result.id, kind: "progress", summary: "once" } };
        enqueue(f.cfg, "/v1/commands", message);
        enqueue(f.cfg, "/v1/commands", message);
        assert.equal(pendingCount(), 2);
        const result = await syncOutbox();
        assert.equal(result.pending, 0);
        assert.equal(Object.values(f.server.workspace.store.snapshot().events).filter(e => e.type === "work.progress").length, 1);
        enqueue(f.cfg, "/v1/commands", { ...message, command: { ...message.command, summary: "different" } });
        const conflict = await syncOutbox();
        assert.equal(conflict.conflicts.length, 1);
        assert.ok(readdirSync(join(f.home, "conflicts")).length);
    }
    finally {
        await f.close();
    }
});
test("unavailable authority keeps an outbox record and reports pending", async () => {
    const f = await fixture();
    try {
        enqueue({ ...f.cfg, server: "http://127.0.0.1:1" }, "/v1/commands", { schemaVersion: 1, operationId: "offline", command: { type: "work.create", title: "must not complete" } });
        const result = await syncOutbox();
        assert.equal(result.pending, 1);
        assert.equal(Object.keys(f.server.workspace.store.snapshot().work).length, 0);
    }
    finally {
        await f.close();
    }
});
test("Claude hook protocol restores scope and rollover without creating a new Run", async () => {
    const f = await fixture();
    try {
        const w = await f.client.command({ type: "work.create", title: "Claude adapter contract", description: "Keep exact target versions" });
        const fake = join(f.home, "claude-protocol.mjs"), captured = join(f.home, "hook-output.json");
        writeFileSync(fake, `#!/usr/bin/env bun
import {readFileSync,writeFileSync} from 'node:fs';import {spawnSync} from 'node:child_process';
const settings=JSON.parse(readFileSync(process.argv[3],'utf8'));const hook=settings.hooks.SessionStart[0].hooks[0].command;
const first=spawnSync('/bin/sh',['-c',hook],{encoding:'utf8',input:JSON.stringify({hook_event_name:'SessionStart',session_id:'session-contract',source:'resume'})});
if(first.status)throw new Error(first.stderr);writeFileSync(${JSON.stringify(captured)},first.stdout);
const compact=spawnSync('/bin/sh',['-c',hook],{encoding:'utf8',input:JSON.stringify({hook_event_name:'SessionStart',session_id:'session-contract',source:'compact'})});if(compact.status)throw new Error(compact.stderr);
const r=spawnSync('wr-next',['done','--summary','contract output'],{stdio:'inherit'});process.exitCode=r.status??1;
`, { mode: 0o700 });
        const result = await launch(f.cfg, { work: w.result.id, argv: [fake], runtime: "claude", isolated: true, cwd: f.home, session: "session-contract" });
        assert.equal(result.exitCode, 0);
        const s = f.server.workspace.store.snapshot();
        assert.equal(Object.keys(s.runs).length, 1);
        assert.equal(Object.keys(s.executions).length, 1);
        const r = Object.values(s.runs)[0]!;
        assert.equal(r.windows.length, 1);
        assert.ok(r.session);
        const output = JSON.parse(readFileSync(captured, "utf8"));
        assert.match(output.hookSpecificOutput.additionalContext, /Keep exact target versions/);
    }
    finally {
        await f.close();
    }
});
test("CLI refuses malformed commands rather than claiming success", async () => {
    const f = await fixture();
    try {
        const r = await run(["not-a-command"]);
        assert.notEqual(r.code, 0);
        assert.equal(r.stdout, "");
        assert.match(r.stderr, /INVALID_ARGUMENT/);
    }
    finally {
        await f.close();
    }
});
