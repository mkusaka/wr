import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir, constants } from "node:os";
import { dirname, join, resolve } from "node:path";
import { EventEmitter } from "node:events";
import { spawnSync, type ChildProcess, type spawn } from "node:child_process";
import { launch } from "../src/runtime/launcher.js";
import { supervise, processExitCode } from "../src/runtime/supervisor.js";
import { writeExecutionContext, capabilityConnection } from "../src/runtime/binding.js";
import { cleanWorkEnvironment } from "../src/runtime/environment.js";
import { Client } from "../src/cli/client.js";
import { startLocal } from "../src/server/local.js";
import { atomic, type Connection, type ContextFile } from "../src/cli/files.js";
import { runtimeAdapter } from "../src/integrations/runtime/adapters.js";
import { NativeRuntimeBridge } from "../src/runtime/native.js";
import { uid } from "../src/domain/util.js";
import ts from "typescript";
async function fixture() {
    const home = mkdtempSync(join(tmpdir(), "wr-next-binder-"));
    const previous = { home: process.env.WR_NEXT_HOME, context: process.env.WR_NEXT_CONTEXT };
    process.env.WR_NEXT_HOME = home;
    delete process.env.WR_NEXT_CONTEXT;
    const server = await startLocal({ database: join(home, "db.sqlite") });
    const cfg: Connection = { server: server.url, workspace: "local", device: "binder-test", token: server.secret };
    atomic(join(home, "connection.json"), cfg);
    const client = new Client(cfg);
    return { home, server, cfg, client, close: async () => {
            await server.close();
            rmSync(home, { recursive: true, force: true });
            if (previous.home === undefined)
                delete process.env.WR_NEXT_HOME;
            else
                process.env.WR_NEXT_HOME = previous.home;
            if (previous.context === undefined)
                delete process.env.WR_NEXT_CONTEXT;
            else
                process.env.WR_NEXT_CONTEXT = previous.context;
        } };
}
for (const file of ["launcher.ts", "supervisor.ts", "binding.ts", "environment.ts", "process.ts"]) {
    test(`generic runtime boundary: ${file} has no provider or installer dependency`, () => {
        const code = readFileSync(resolve("src/runtime", file), "utf8");
        const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
        for (const statement of source.statements) {
            if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) {
                const specifier = statement.moduleSpecifier;
                if (specifier && ts.isStringLiteral(specifier))
                    assert.doesNotMatch(specifier.text, /integrations|git\/hooks|claude|codex|omp/);
            }
        }
        assert.doesNotMatch(code, /--settings|staticHookDocument|requireInstalled|runtimeNames|claude-settings/);
    });
}
test("generic binder preserves argv and creates no integration settings or lifecycle sidecar", async () => {
    const f = await fixture();
    try {
        const w = await f.client.command({ type: "work.create", title: "verbatim argv" });
        const output = join(f.home, "captured.json"), script = join(f.home, "child.mjs");
        writeFileSync(script, `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(output)},JSON.stringify({args:process.argv.slice(2),env:process.env,ctx:JSON.parse(fs.readFileSync(process.env.WR_NEXT_CONTEXT,'utf8'))}));`);
        const argv = [process.execPath, script, "--settings", "user supplied.json", "a b", "'quoted'", ";not-a-shell", ""];
        const original = [...argv];
        const r = await launch(f.cfg, { work: w.result.id, argv, cwd: f.home, runtime: "custom-runtime",
            env: { ...process.env, WR_NEXT_TOKEN: "PARENT_SECRET", WR_NEXT_CUSTOM_SECRET: "LEAK", WR_NEXT_RUNTIME_CONNECTION: "/parent", WR_NEXT_RUNTIME_AGENT: "parent", WR_PARENT_CLI_SESSION: "ancestor" } });
        assert.equal(r.exitCode, 0);
        assert.deepEqual(argv, original);
        const captured = JSON.parse(readFileSync(output, "utf8"));
        assert.deepEqual(captured.args, argv.slice(2));
        assert.equal(captured.env.WR_NEXT_RUNTIME_KIND, "custom-runtime");
        for (const name of ["WR_NEXT_TOKEN", "WR_NEXT_CUSTOM_SECRET", "WR_NEXT_RUNTIME_CONNECTION", "WR_NEXT_RUNTIME_AGENT", "WR_PARENT_CLI_SESSION"])
            assert.equal(captured.env[name], undefined, name);
        assert.notEqual(captured.ctx.token, f.cfg.token);
        assert.equal(captured.ctx.localAuthority, undefined);
        assert.equal(captured.ctx.integration, undefined);
        assert.equal(existsSync(join(dirname(r.receipt), "runtime-connection.json")), false);
        assert.equal(existsSync(join(dirname(r.receipt), "claude-settings.json")), false);
        const state = f.server.workspace.store.snapshot();
        assert.equal(state.work[w.result.id]!.state, "open");
        assert.equal(state.runs[Object.keys(state.runs)[0]!]!.runtime, "custom-runtime");
    }
    finally {
        await f.close();
    }
});
test("a real program exiting 127 is ended, not a fabricated spawn failure", async () => {
    const f = await fixture();
    try {
        const w = await f.client.command({ type: "work.create", title: "exit code is not spawn evidence" });
        const r = await launch(f.cfg, { work: w.result.id, argv: [process.execPath, "-e", "process.exit(127)"], cwd: f.home });
        assert.equal(r.exitCode, 127);
        const receipt = JSON.parse(readFileSync(r.receipt, "utf8"));
        assert.equal(receipt.state, "ended");
        assert.equal(receipt.outcome, "exited");
        assert.ok(receipt.process.pid);
        const events = Object.values(f.server.workspace.store.snapshot().events);
        assert.equal(events.filter(e => e.type === "runtime.started").length, 1);
        assert.equal(events.filter(e => e.type === "runtime.ended").length, 1);
        assert.equal(events.filter(e => e.type === "runtime.launch_failed").length, 0);
    }
    finally {
        await f.close();
    }
});
test("missing executable is a spawn failure, with a failed receipt and no fake PID", async () => {
    const f = await fixture();
    try {
        const w = await f.client.command({ type: "work.create", title: "not launched" });
        const r = await launch(f.cfg, { work: w.result.id, argv: [join(f.home, "does-not-exist")], cwd: f.home });
        assert.equal(r.exitCode, 127);
        const receipt = JSON.parse(readFileSync(r.receipt, "utf8"));
        assert.equal(receipt.state, "failed");
        assert.equal(receipt.outcome, "spawn_failed");
        assert.equal(receipt.process, null);
        assert.equal(Object.values(f.server.workspace.store.snapshot().events).filter(e => e.type === "runtime.launch_failed").length, 1);
    }
    finally {
        await f.close();
    }
});
test("actual signal exit is preserved rather than mapped to SIGTERM", async () => {
    const f = await fixture();
    try {
        const w = await f.client.command({ type: "work.create", title: "signal evidence" });
        const r = await launch(f.cfg, { work: w.result.id, argv: [process.execPath, "-e", "process.kill(process.pid,'SIGUSR2')"], cwd: f.home });
        assert.equal(r.exitCode, 128 + constants.signals.SIGUSR2);
        const receipt = JSON.parse(readFileSync(r.receipt, "utf8"));
        assert.equal(receipt.signal, "SIGUSR2");
        assert.equal(receipt.outcome, "exited");
    }
    finally {
        await f.close();
    }
});
test("invalid argv is rejected before any execution is claimed", async () => {
    const f = await fixture();
    try {
        const w = await f.client.command({ type: "work.create", title: "invalid input" });
        await assert.rejects(launch(f.cfg, { work: w.result.id, argv: ["bad\0argv"], cwd: f.home }), (error: any) => error.code === "INVALID_COMMAND");
        assert.equal(Object.keys(f.server.workspace.store.snapshot().executions).length, 0);
    }
    finally {
        await f.close();
    }
});
function fakeChild() {
    const child = new EventEmitter() as EventEmitter & {
        pid: number;
        exitCode: number | null;
        signalCode: NodeJS.Signals | null;
        kill: (signal: NodeJS.Signals) => boolean;
    };
    child.pid = 123;
    child.exitCode = null;
    child.signalCode = null;
    child.kill = () => true;
    return { child, spawn: (() => child as unknown as ChildProcess) as unknown as typeof spawn };
}
test("post-spawn error does not settle supervision or release ownership", async () => {
    const fake = fakeChild();
    let settled = false, uncertain = 0;
    const before = process.listenerCount("SIGTERM");
    const pending = supervise(["fake"], "/tmp", {}, { started() { }, uncertain() { uncertain++; } }, fake.spawn).then(r => { settled = true; return r; });
    fake.child.emit("spawn");
    fake.child.emit("error", new Error("kill failed"));
    await new Promise(r => setImmediate(r));
    assert.equal(settled, false);
    assert.equal(uncertain, 1);
    fake.child.exitCode = 0;
    fake.child.emit("exit", 0, null);
    assert.deepEqual(await pending, { kind: "exited", code: 0, signal: null });
    assert.equal(process.listenerCount("SIGTERM"), before);
});
test("recorder failures do not detach from a live child or throw from the spawn callback", async () => {
    const fake = fakeChild();
    let uncertain = 0;
    const pending = supervise(["fake"], "/tmp", {}, { started() { throw new Error("disk full"); }, uncertain() { uncertain++; throw new Error("still unavailable"); } }, fake.spawn);
    assert.doesNotThrow(() => fake.child.emit("spawn"));
    assert.equal(uncertain, 1);
    fake.child.emit("exit", 17, null);
    assert.equal((await pending).code, 17);
});
test("error plus exit settles once and removes signal forwarding", async () => {
    const fake = fakeChild(), before = process.listenerCount("SIGINT");
    let started = 0;
    const pending = supervise(["fake"], "/tmp", {}, { started() { started++; }, uncertain() { } }, fake.spawn);
    fake.child.emit("error", new Error("ENOENT"));
    fake.child.emit("exit", 1, null);
    assert.equal((await pending).kind, "spawn_failed");
    assert.equal(started, 0);
    assert.equal(process.listenerCount("SIGINT"), before);
});
test("synchronous spawn errors are distinct from program exit and leave no listeners", async () => {
    const before = process.listenerCount("SIGTERM");
    const r = await supervise(["fake"], "/tmp", {}, { started() { throw new Error("unexpected"); }, uncertain() { } }, (() => { throw new Error("invalid spawn"); }) as unknown as typeof spawn);
    assert.equal(r.kind, "spawn_failed");
    assert.equal(process.listenerCount("SIGTERM"), before);
});
test("exit code helper preserves nonzero program codes and OS signal numbers", () => {
    assert.equal(processExitCode(127, null), 127);
    assert.equal(processExitCode(null, "SIGINT"), 130);
    assert.equal(processExitCode(null, "SIGTERM"), 143);
    assert.equal(processExitCode(null, "SIGKILL"), 137);
});
test("context issuance whitelists authority and binding fields for both launch paths", () => {
    const home = mkdtempSync(join(tmpdir(), "wr-next-context-"));
    try {
        const cfg = { server: "http://localhost", workspace: "w", device: "d", token: "OPERATOR", localAuthority: { database: "/secret", pid: 1, processIdentity: "pid" }, secretExtra: "PRIVATE" };
        const binding = { execution: "e", run: "r", work: "w", key: "W1", scopeRevision: 1, generation: 1, environment: "/tree", runtimeAgent: "a", runtimeRoot: "root", secretBinding: "HIDDEN" };
        const ctx = writeExecutionContext(join(home, "ctx.json"), cfg, binding, { worker: "WORKER", launcher: "LAUNCHER", git: "GIT", github: "GH" });
        const bytes = readFileSync(join(home, "ctx.json"), "utf8");
        for (const secret of ["OPERATOR", "PRIVATE", "HIDDEN", "/secret"])
            assert.equal(bytes.includes(secret), false);
        assert.equal(ctx.token, "WORKER");
        assert.equal(ctx.runtimeAgent, "a");
        assert.equal(capabilityConnection({ ...cfg, accessToken: "ACCESS" }, "CAP").accessToken, "ACCESS");
    }
    finally {
        rmSync(home, { recursive: true, force: true });
    }
});
test("environment cleaning is total for wr binding fields and preserves user PATH/settings", () => {
    const clean = cleanWorkEnvironment({ WR_NEXT_HOME: "/private", WR_NEXT_CONTEXT: "/old", WR_NEXT_FUTURE_TOKEN: "bad", PATH: "/bin", USER_SETTING: "yes", WR_EXECUTION_ID: "old" });
    assert.deepEqual(clean, { WR_NEXT_HOME: "/private", PATH: "/bin", USER_SETTING: "yes" });
});
for (const runtime of ["claude", "codex", "omp"] as const) {
    test(`${runtime}: normalized lifecycle retains session-end and child-quiescence distinction`, () => {
        const a = runtimeAdapter(runtime);
        const session = a.decode(JSON.stringify({ hook_event_name: "SessionEnd", session_id: "s" }));
        const child = a.decode(JSON.stringify({ hook_event_name: "SubagentStop", session_id: "s", agent_id: "child" }));
        assert.equal(session.kind, "session_ended");
        assert.equal(child.kind, "child_quiescent");
        assert.equal(a.guard(child)?.kind, "ignore");
        assert.equal(a.decode(JSON.stringify({ hook_event_name: "SessionStart", source: "compact", session_id: "s", turn_id: "not-an-event" })).nativeEventId, undefined);
    });
    test(`${runtime}: successful tool observation and failed output remain distinct`, () => {
        const a = runtimeAdapter(runtime);
        const raw = { hook_event_name: "PostToolUse", session_id: "s", tool_name: "Bash", tool_input: { command: "gh pr create" }, tool_response: { stdout: "result", exit_code: 0 } };
        assert.equal(a.decode(JSON.stringify(raw)).tool?.succeeded, true);
        raw.tool_response.exit_code = 7;
        assert.equal(a.decode(JSON.stringify(raw)).tool?.succeeded, false);
        assert.throws(() => a.decode(JSON.stringify({ ...raw, tool_input: { command: [] } })));
        assert.throws(() => a.decode(JSON.stringify({ hook_event_name: "invented" })));
    });
}
test("Claude SendMessage cannot bypass unbound actor routing", () => {
    const a = runtimeAdapter("claude"), event = a.decode(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "SendMessage", session_id: "s" }));
    assert.equal(a.guard(event)?.kind, "deny");
});
test("native attach and resume view require no launcher or new process per context window", async () => {
    const f = await fixture();
    try {
        const w = await f.client.command({ type: "work.create", title: "native session", description: "Current requirements" });
        const bridge = await NativeRuntimeBridge.attach(f.cfg, { work: w.result.id, runtime: "harness", externalSessionId: "session", agentId: "main", invocationId: "invocation", environment: f.home }, uid("attach"));
        const before = f.server.workspace.store.snapshot();
        const text = await bridge.resumeContext(bridge.root);
        assert.match(text, /Current requirements/);
        assert.match(text, /continues the same Execution/);
        const env = await bridge.toolEnvironment(bridge.root, { PATH: "/bin", WR_NEXT_TOKEN: "operator-override" });
        const ctx = JSON.parse(readFileSync(env.WR_NEXT_CONTEXT!, "utf8")) as ContextFile;
        assert.equal(ctx.localAuthority, undefined);
        assert.notEqual(ctx.token, f.cfg.token);
        assert.equal(env.WR_NEXT_TOKEN, undefined);
        assert.equal(env.WR_NEXT_RUNTIME_CONNECTION, undefined);
        const after = f.server.workspace.store.snapshot();
        assert.equal(Object.keys(after.runs).length, Object.keys(before.runs).length);
        assert.equal(Object.keys(after.executions).length, Object.keys(before.executions).length);
        assert.equal(existsSync(join(f.home, "launches")), false);
    }
    finally {
        await f.close();
    }
});
test("legacy PreToolUse fails closed on a missing context rather than using Git's exit-zero policy", () => {
    const missing = join(tmpdir(), uid("absent-context"));
    const r = spawnSync(process.execPath, [resolve("dist/src/cli/main.js"), "internal", "runtime-event"], {
        encoding: "utf8", input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash" }),
        env: { ...process.env, WR_NEXT_CONTEXT: missing, WR_NEXT_RUNTIME_KIND: "claude" },
    });
    assert.equal(r.status, 2, r.stderr);
    assert.equal(r.stdout, "");
});
test("legacy callback from another runtime cannot read its inherited parent context", () => {
    const r = spawnSync(process.execPath, [resolve("dist/src/cli/main.js"), "internal", "runtime-event"], {
        encoding: "utf8", input: "deliberately invalid JSON",
        env: { ...process.env, WR_NEXT_CONTEXT: "/missing-parent-secret", WR_NEXT_RUNTIME_KIND: "codex" },
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, "");
});
test("normalized event does not carry unrelated raw prompt or secret metadata", () => {
    const event = runtimeAdapter("codex").decode(JSON.stringify({ hook_event_name: "SessionStart", session_id: "actual-session", prompt: "PRIVATE_PROMPT", token: "PRIVATE_TOKEN" }));
    assert.equal(JSON.stringify(event).includes("PRIVATE_"), false);
    assert.equal(event.sessionId, "actual-session");
});
