import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { atomic, type Connection } from "../src/cli/files.js";
import { processIdentity } from "../src/runtime/launcher.js";
const cli = resolve("dist/src/cli/main.js");
function run(args: string[], home: string, extra: NodeJS.ProcessEnv = {}): Promise<{
    code: number;
    stdout: string;
    stderr: string;
}> {
    const env: NodeJS.ProcessEnv = { ...process.env, WR_NEXT_HOME: home, ...extra };
    for (const key of ["WR_NEXT_CONTEXT", "WR_NEXT_TOKEN", "WR_NEXT_SERVER", "WR_NEXT_RUNTIME_AGENT", "WR_NEXT_BINDING_REQUIRED"])
        if (!(key in extra))
            delete env[key];
    return new Promise((resolvePromise, reject) => {
        const child = spawn(process.execPath, [cli, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "", stderr = "";
        child.stdout.on("data", x => stdout += x);
        child.stderr.on("data", x => stderr += x);
        child.once("error", reject);
        child.once("close", code => resolvePromise({ code: code ?? 1, stdout, stderr }));
    });
}
async function cleanup(home: string) {
    const path = join(home, "connection.json");
    if (existsSync(path)) {
        const cfg = JSON.parse(readFileSync(path, "utf8")) as Connection;
        if (cfg.localAuthority && processIdentity(cfg.localAuthority.pid) === cfg.localAuthority.processIdentity)
            await run(["authority", "stop"], home);
    }
    rmSync(home, { recursive: true, force: true });
}
test("concurrent first CLI invocations share one authenticated local authority; restart preserves work", async () => {
    const home = mkdtempSync(join(tmpdir(), "wr-next-autostart-"));
    try {
        const outputs = await Promise.all([run(["add", "A"], home), run(["add", "B"], home), run(["status"], home)]);
        for (const output of outputs)
            assert.equal(output.code, 0, output.stderr);
        const cfg = JSON.parse(readFileSync(join(home, "connection.json"), "utf8")) as Connection;
        assert.ok(cfg.localAuthority);
        const status = await run(["status", "--format", "json"], home);
        assert.equal(JSON.parse(status.stdout).items.length, 2);
        assert.ok(!existsSync(join(home, ".authority-start.lock")));
        const stop = await run(["authority", "stop"], home);
        assert.equal(stop.code, 0, stop.stderr);
        assert.equal(processIdentity(cfg.localAuthority!.pid), null);
        const restarted = await run(["status", "--format", "json"], home);
        assert.equal(restarted.code, 0, restarted.stderr);
        assert.equal(JSON.parse(restarted.stdout).items.length, 2);
        const next = JSON.parse(readFileSync(join(home, "connection.json"), "utf8")) as Connection;
        assert.equal(next.localAuthority!.database, cfg.localAuthority!.database);
        assert.equal(next.device, cfg.device);
        assert.equal(next.token, cfg.token);
        assert.notEqual(next.localAuthority!.pid, cfg.localAuthority!.pid);
    }
    finally {
        await cleanup(home);
    }
});
test("managed unbound child cannot autostart or fall back to a local operator", async () => {
    const home = mkdtempSync(join(tmpdir(), "wr-next-no-fallback-"));
    try {
        const r = await run(["add", "must not exist"], home, { WR_NEXT_BINDING_REQUIRED: "1" });
        assert.notEqual(r.code, 0);
        assert.match(r.stderr, /UNBOUND_RUNTIME_ACTOR/);
        assert.ok(!existsSync(join(home, "connection.json")));
        assert.ok(!existsSync(join(home, "workspace.sqlite")));
    }
    finally {
        await cleanup(home);
    }
});
test("unknown database and malformed CLI never trigger a fresh authority", async () => {
    const home = mkdtempSync(join(tmpdir(), "wr-next-unknown-db-"));
    try {
        const typo = await run(["not-a-command"], home);
        assert.notEqual(typo.code, 0);
        assert.ok(!existsSync(join(home, "connection.json")));
        writeFileSync(join(home, "workspace.sqlite"), "unidentified fixture");
        const r = await run(["status"], home);
        assert.notEqual(r.code, 0);
        assert.match(r.stderr, /AUTHORITY_START_UNKNOWN/);
        assert.equal(readFileSync(join(home, "workspace.sqlite"), "utf8"), "unidentified fixture");
    }
    finally {
        await cleanup(home);
    }
});
test("an explicit disconnected profile never becomes a different local authority", async () => {
    const home = mkdtempSync(join(tmpdir(), "wr-next-explicit-profile-"));
    try {
        const cfg = { server: "http://127.0.0.1:1", workspace: "explicit", device: "d", token: "invalid-test" };
        atomic(join(home, "connection.json"), cfg);
        const r = await run(["status"], home);
        assert.notEqual(r.code, 0);
        assert.deepEqual(JSON.parse(readFileSync(join(home, "connection.json"), "utf8")), cfg);
        assert.ok(!existsSync(join(home, "workspace.sqlite")));
    }
    finally {
        await cleanup(home);
    }
});
