import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { startLocal } from "../src/server/local.js";
import { Client, syncOutbox } from "../src/cli/client.js";
import { atomic, type Connection } from "../src/cli/files.js";
import { runWork as launch } from "../src/cli/run.js";
import { nativeGuard } from "../src/runtime/events.js";
import { syncIntegrations } from "../src/integrations/runtime-config/project.js";
import { groups, ompExtension } from "../src/integrations/runtime-config/catalog.js";
import ts from "typescript";
const cli = resolve("dist/src/cli/main.js");
async function exec(argv: string[], options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: string;
} = {}): Promise<{
    code: number;
    stdout: string;
    stderr: string;
}> {
    return new Promise((done, reject) => {
        const p = spawn(process.execPath, [cli, ...argv], { cwd: options.cwd, env: options.env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
        let stdout = "", stderr = "";
        p.on("error", reject);
        p.stdout.on("data", x => stdout += x);
        p.stderr.on("data", x => stderr += x);
        p.on("close", code => done({ code: code ?? 1, stdout, stderr }));
        p.stdin.end(options.input ?? "");
    });
}
async function fixture() {
    const home = mkdtempSync(join(tmpdir(), "wr-next-static-")), repo = join(home, "repo"), previous = { home: process.env.WR_NEXT_HOME, context: process.env.WR_NEXT_CONTEXT, runtime: process.env.WR_NEXT_RUNTIME_KIND };
    mkdirSync(repo);
    assert.equal(spawnSync("git", ["init", "-q", repo]).status, 0);
    process.env.WR_NEXT_HOME = home;
    delete process.env.WR_NEXT_CONTEXT;
    delete process.env.WR_NEXT_RUNTIME_KIND;
    const server = await startLocal({ database: join(home, "workspace.sqlite") });
    const cfg: Connection = { server: server.url, workspace: "local", device: "static-test", token: server.secret };
    atomic(join(home, "connection.json"), cfg);
    return { home, repo, server, cfg, client: new Client(cfg), async close() {
            await server.close();
            rmSync(home, { recursive: true, force: true });
            for (const [key, value] of [["WR_NEXT_HOME", previous.home], ["WR_NEXT_CONTEXT", previous.context], ["WR_NEXT_RUNTIME_KIND", previous.runtime]] as const) {
                if (value === undefined)
                    delete process.env[key];
                else
                    process.env[key] = value;
            }
        } };
}
const invokeCode = `
import {readFileSync,writeFileSync} from 'node:fs';import {spawnSync} from 'node:child_process';import {join} from 'node:path';
const source=process.env.WR_NEXT_RUNTIME_KIND;
const file=source==='claude'?'.claude/settings.json':'.codex/hooks.json';
const hooks=JSON.parse(readFileSync(file,'utf8')).hooks;
function hook(event, extra={}) {
 const command=hooks[event].find(g=>g.hooks.some(h=>h.command.includes('wr-next internal integration-event'))).hooks.find(h=>h.command.includes('wr-next internal integration-event')).command;
 return spawnSync('/bin/sh',['-c',command],{encoding:'utf8',input:JSON.stringify({hook_event_name:event,session_id:'native-root-session',cwd:process.cwd(),...extra})});
}
`;
for (const runtime of ["claude", "codex"] as const)
    test(`${runtime} uses permanent settings without --settings and reports to the correct work`, async () => {
        const f = await fixture();
        try {
            syncIntegrations(f.repo, { runtimes: [runtime] });
            const w = await f.client.command({ type: "work.create", title: "project binding", description: "Do not duplicate work" });
            const script = join(f.home, "native-contract.mjs");
            writeFileSync(script, invokeCode + `
if(process.argv.includes('--settings'))throw new Error('must not inject project settings');
const started=hook('SessionStart',{source:'startup'});if(started.status)throw new Error(started.stderr);
if(!JSON.parse(started.stdout).hookSpecificOutput.additionalContext.includes('Do not duplicate work'))throw new Error('missing guidance');
const tool=hook('PreToolUse',{tool_name:'Bash',tool_input:{command:'echo ok'},tool_use_id:'t1'});if(tool.status)throw new Error(tool.stderr);
const rollover=hook('SessionStart',{source:'compact',event_id:'compact-1'});if(rollover.status)throw new Error(rollover.stderr);
const again=hook('SessionStart',{source:'compact',event_id:'compact-1'});if(again.status)throw new Error(again.stderr);
const submitted=spawnSync('wr-next',['done','--summary','completed via project integration'],{stdio:'inherit'});process.exitCode=submitted.status??1;
`);
            const r = await launch(f.cfg, { work: w.result.id, runtime, cwd: f.repo, argv: [process.execPath, script] });
            assert.equal(r.exitCode, 0);
            const state = f.server.workspace.store.snapshot();
            assert.equal(state.work[w.result.id]!.state, "done");
            assert.equal(Object.keys(state.runs).length, 1);
            assert.equal(Object.values(state.runs)[0]!.runtime, runtime);
            assert.equal(Object.values(state.runs)[0]!.windows.length, 1);
            const launchDir = join(f.home, "launches", readdirSync(join(f.home, "launches"))[0]!);
            assert.equal(existsSync(join(launchDir, "claude-settings.json")), false);
            assert.equal(JSON.parse(readFileSync(join(launchDir, "integration-seen.json"), "utf8")).source, runtime);
        }
        finally {
            await f.close();
        }
    });
test("missing permanent integration fails before claim or process spawn", async () => {
    const f = await fixture();
    try {
        const w = await f.client.command({ type: "work.create", title: "missing init" });
        await assert.rejects(launch(f.cfg, { work: w.result.id, runtime: "codex", cwd: f.repo, argv: [process.execPath, "-e", "process.exit(9)"] }), (e: any) => e.code === "INTEGRATION_NOT_READY");
        assert.equal(Object.keys(f.server.workspace.store.snapshot().executions).length, 0);
    }
    finally {
        await f.close();
    }
});
test("unmanaged permanent hooks never start an authority or block unrelated subagents", async () => {
    const home = mkdtempSync(join(tmpdir(), "wr-next-ambient-"));
    try {
        const env: NodeJS.ProcessEnv = { ...process.env, WR_NEXT_HOME: home, WR_NEXT_RUNTIME_KIND: "claude" };
        delete env.WR_NEXT_CONTEXT;
        delete env.WR_NEXT_BINDING_REQUIRED;
        const out = await exec(["internal", "integration-event", "--source", "claude", "--adapter-version", "1", "--installation", "project", "--event", "PreToolUse"], { env, input: JSON.stringify({ hook_event_name: "PreToolUse", agent_id: "foreign", tool_name: "Agent" }) });
        assert.equal(out.code, 0);
        assert.equal(out.stdout, "");
        assert.equal(existsSync(join(home, "connection.json")), false);
        assert.deepEqual(readdirSync(home), []);
    }
    finally {
        rmSync(home, { recursive: true, force: true });
    }
});
test("OMP cross-discovered Claude/Codex wrappers do not touch inherited capabilities", async () => {
    for (const source of ["claude", "codex"]) {
        const out = await exec(["internal", "integration-event", "--source", source, "--adapter-version", "1", "--installation", "project", "--event", "PreToolUse"], { env: { ...process.env, WR_NEXT_RUNTIME_KIND: "omp", WR_NEXT_CONTEXT: "/does/not/exist" }, input: "not-json" });
        assert.equal(out.code, 0);
        assert.equal(out.stdout, "");
        assert.equal(out.stderr, "");
    }
});
test("native child pre-tool calls are denied before a parent context is opened", async () => {
    for (const source of ["claude", "codex", "omp"]) {
        const out = await exec(["internal", "integration-event", "--source", source, "--adapter-version", "1", "--installation", "project", "--event", "PreToolUse"], { env: { ...process.env, WR_NEXT_RUNTIME_KIND: source, WR_NEXT_CONTEXT: "/does/not/exist" }, input: JSON.stringify({ hook_event_name: "PreToolUse", agent_id: "native-child", tool_name: "Bash" }) });
        assert.equal(out.code, 0);
        assert.equal(JSON.parse(out.stdout).hookSpecificOutput.permissionDecision, "deny");
    }
});
test("malformed managed blocking payload exits 2; it is not an implicit allow", async () => {
    const out = await exec(["internal", "integration-event", "--source", "codex", "--adapter-version", "1", "--installation", "project", "--event", "PreToolUse"], { env: { ...process.env, WR_NEXT_RUNTIME_KIND: "codex", WR_NEXT_CONTEXT: "/does/not/exist" }, input: "not-json" });
    assert.equal(out.code, 2);
    assert.equal(out.stdout, "");
});
test("Codex native spawn is denied without synthetic session IDs or work assignment guesses", () => {
    for (const name of ["spawn_agent", "Agent", "send_input", "resume_agent"]) {
        const out: any = nativeGuard({ hook_event_name: "PreToolUse", tool_name: name }, "codex");
        assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
    }
    assert.equal(nativeGuard({ hook_event_name: "PreToolUse", tool_name: "apply_patch" }, "codex"), null);
    assert.deepEqual(nativeGuard({ hook_event_name: "SubagentStop", agent_id: "child" }, "codex"), {});
});
test("an installed-but-not-loaded runtime is not reported as active/complete", async () => {
    const f = await fixture();
    try {
        syncIntegrations(f.repo, { runtimes: ["codex"] });
        const w = await f.client.command({ type: "work.create", title: "trust missing" });
        const r = await launch(f.cfg, { work: w.result.id, runtime: "codex", cwd: f.repo, argv: [process.execPath, "-e", "process.exit(0)"] });
        assert.equal(r.exitCode, 0);
        assert.equal(f.server.workspace.store.snapshot().work[w.result.id]!.state, "open");
        const dir = join(f.home, "launches", readdirSync(join(f.home, "launches"))[0]!);
        assert.equal(existsSync(join(dir, "integration-seen.json")), false);
    }
    finally {
        await f.close();
    }
});
test("changed runtime session does not overwrite root attribution", async () => {
    const f = await fixture();
    try {
        syncIntegrations(f.repo, { runtimes: ["codex"] });
        const w = await f.client.command({ type: "work.create", title: "session mismatch" });
        const script = join(f.home, "mismatch.mjs");
        writeFileSync(script, invokeCode + `
if(hook('SessionStart',{source:'startup'}).status)throw new Error('startup');
const denied=hook('PreToolUse',{session_id:'other-session',tool_name:'Bash'});if(denied.status!==2)throw new Error('must deny mismatch');
`);
        const r = await launch(f.cfg, { work: w.result.id, runtime: "codex", cwd: f.repo, argv: [process.execPath, script] });
        assert.equal(r.exitCode, 0);
        assert.equal(Object.keys(f.server.workspace.store.snapshot().sessions).length, 1);
    }
    finally {
        await f.close();
    }
});
test("isolated Claude selects only temporary hooks even when project hooks are also loaded", async () => {
    const f = await fixture();
    try {
        syncIntegrations(f.repo, { runtimes: ["claude"] });
        const w = await f.client.command({ type: "work.create", title: "isolated" });
        const script = join(f.home, "claude-contract"), projected = groups("claude").SessionStart!.hooks[0]!.command;
        writeFileSync(script, `#!/usr/bin/env bun
import {readFileSync} from 'node:fs';import {spawnSync} from 'node:child_process';
const input=JSON.stringify({hook_event_name:'SessionStart',session_id:'root',source:'startup'});
const settings=JSON.parse(readFileSync(process.argv[3],'utf8'));
const p=spawnSync('/bin/sh',['-c',${JSON.stringify(projected)}],{input,encoding:'utf8'});if(p.stdout.trim())throw new Error('project must be skipped');
const r=spawnSync('/bin/sh',['-c',settings.hooks.SessionStart[0].hooks[0].command],{input,encoding:'utf8'});if(!r.stdout.includes('isolated'))throw new Error(r.stderr||'no isolated event');
`, { mode: 0o700 });
        const r = await launch(f.cfg, { work: w.result.id, runtime: "claude", isolated: true, cwd: f.repo, argv: [script] });
        assert.equal(r.exitCode, 0);
        assert.equal(Object.keys(f.server.workspace.store.snapshot().runtimeAgents).length, 1);
    }
    finally {
        await f.close();
    }
});
test("SessionEnd notification does not release a live writer", async () => {
    const f = await fixture();
    try {
        syncIntegrations(f.repo, { runtimes: ["codex"] });
        const w = await f.client.command({ type: "work.create", title: "advisory end" });
        const script = join(f.home, "end.mjs"), marker = join(f.home, "session-ended");
        writeFileSync(script, invokeCode + `
if(hook('SessionStart',{source:'startup'}).status)throw new Error('startup');hook('SessionEnd');
writeFileSync(${JSON.stringify(marker)},'ok');setTimeout(()=>{},900);
`);
        const running = launch(f.cfg, { work: w.result.id, runtime: "codex", cwd: f.repo, argv: [process.execPath, script] });
        for (let i = 0; i < 200 && !existsSync(marker); i++)
            await new Promise(r => setTimeout(r, 20));
        assert.ok(existsSync(marker));
        await syncOutbox();
        assert.equal(Object.values(f.server.workspace.store.snapshot().reservations).filter(x => x.state === "active").length, 1);
        await running;
    }
    finally {
        await f.close();
    }
});
test("generated OMP module registers once per host API, but registers again after reload", async () => {
    const module = ts.transpileModule(ompExtension(), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
    const entry = await import(`data:text/javascript;base64,${Buffer.from(module).toString("base64")}`);
    const callbacks = new Map<string, Function[]>();
    const host = { on(name: string, cb: Function) { callbacks.set(name, [...(callbacks.get(name) ?? []), cb]); } };
    entry.default(host);
    entry.default(host);
    assert.equal(callbacks.get("tool_call")!.length, 1);
    assert.equal(callbacks.get("session_start")!.length, 1);
    entry.default({ on: host.on });
    assert.equal(callbacks.get("tool_call")!.length, 2);
});
test("CLI init/install/status/uninstall needs no authority and retains user hooks", async () => {
    const home = mkdtempSync(join(tmpdir(), "wr-next-cli-init-")), repo = join(home, "repo");
    try {
        mkdirSync(repo);
        spawnSync("git", ["init", "-q", repo]);
        const env: NodeJS.ProcessEnv = { ...process.env, WR_NEXT_HOME: join(home, "state") };
        delete env.WR_NEXT_CONTEXT;
        delete env.WR_NEXT_BINDING_REQUIRED;
        const out = await exec(["init", "--runtime", "claude,codex,omp,devin", "--no-git-hooks"], { env, cwd: repo });
        assert.equal(out.code, 0, out.stderr);
        assert.equal(existsSync(join(home, "state/connection.json")), false);
        assert.equal((await exec(["integrations"], { env, cwd: repo })).code, 0);
        assert.equal((await exec(["integrations", "sync"], { env, cwd: repo })).code, 0);
        assert.equal((await exec(["integrations", "uninstall", "codex"], { env, cwd: repo })).code, 0);
        assert.equal((await exec(["integrations", "install", "codex"], { env, cwd: repo })).code, 0);
    }
    finally {
        rmSync(home, { recursive: true, force: true });
    }
});
test("custom Git hook manager survives init and is reported as requiring integration", async () => {
    const home = mkdtempSync(join(tmpdir(), "wr-next-manager-"));
    try {
        spawnSync("git", ["init", "-q", home]);
        spawnSync("git", ["-C", home, "config", "core.hooksPath", ".custom-hooks"]);
        const out = await exec(["init", "--runtime", "claude"], { cwd: home, env: { ...process.env, WR_NEXT_HOME: join(home, "state") } });
        assert.equal(out.code, 2);
        assert.equal(JSON.parse(out.stdout).gitHooks.state, "manual-action-required");
        assert.equal(spawnSync("git", ["-C", home, "config", "--get", "core.hooksPath"], { encoding: "utf8" }).stdout.trim(), ".custom-hooks");
    }
    finally {
        rmSync(home, { recursive: true, force: true });
    }
});
test("OMP permanent extension forwards root lifecycle, restores context and denies unbound tasks", async () => {
    const f = await fixture();
    try {
        syncIntegrations(f.repo, { runtimes: ["omp", "claude", "codex"] });
        const w = await f.client.command({ type: "work.create", title: "OMP integration contract", description: "Preserve this requirement" });
        const extension = join(f.home, "omp-extension.mjs");
        writeFileSync(extension, ts.transpileModule(ompExtension(), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
        const script = join(f.home, "omp-contract.mjs");
        writeFileSync(script, `
import install from ${JSON.stringify("file://" + extension)};
import {spawnSync} from 'node:child_process';
const handlers=new Map(); const api={on:(name,fn)=>handlers.set(name,fn)};
const ctx={cwd:process.cwd(),sessionManager:{getSessionId:()=>"omp-session"},ui:{notify:(s)=>{throw new Error(s)}}};
install(api);
await handlers.get('session_start')({},ctx);
const prompt=await handlers.get('before_agent_start')({},ctx);if(!prompt?.message.content.includes('Preserve this requirement'))throw new Error('context missing');
const denied=await handlers.get('tool_call')({toolName:'task',toolCallId:'child-1',input:{}},ctx);if(!denied?.block)throw new Error('unbound task allowed');
const allowed=await handlers.get('tool_call')({toolName:'bash',toolCallId:'root-1',input:{command:'echo example'}},ctx);if(allowed?.block)throw new Error(allowed.reason);
await handlers.get('session_compact')({compactionEntry:{id:'compact-omp-1'}},ctx);
const done=spawnSync('wr-next',['done','--summary','OMP work submitted'],{stdio:'inherit'});if(done.status)throw new Error('submit failed');
await handlers.get('session_shutdown')({},ctx);
`);
        const r = await launch(f.cfg, { work: w.result.id, runtime: "omp", cwd: f.repo, argv: [process.execPath, script] });
        assert.equal(r.exitCode, 0);
        const state = f.server.workspace.store.snapshot();
        assert.equal(state.work[w.result.id]!.state, "done");
        assert.equal(Object.keys(state.runs).length, 1);
        assert.equal(Object.values(state.runs)[0]!.windows.length, 1);
        assert.equal(Object.values(state.runs)[0]!.runtime, "omp");
        assert.equal(Object.keys(state.runtimeAgents).length, 1);
    }
    finally {
        await f.close();
    }
});
test("malformed actor identity is not treated as a root event", async () => {
    for (const source of ["claude", "codex", "omp"]) {
        const out = await exec(["internal", "integration-event", "--source", source, "--adapter-version", "1", "--installation", "project", "--event", "PreToolUse"], { env: { ...process.env, WR_NEXT_RUNTIME_KIND: source, WR_NEXT_CONTEXT: "/does/not/exist" }, input: JSON.stringify({ hook_event_name: "PreToolUse", agent_id: { invalid: true }, tool_name: "Bash" }) });
        assert.equal(out.code, 2);
        assert.match(out.stderr, /agent_id/);
    }
});
test("multiple compactions in one turn are not collapsed by turn_id", async () => {
    const f = await fixture();
    try {
        syncIntegrations(f.repo, { runtimes: ["codex"] });
        const w = await f.client.command({ type: "work.create", title: "multiple windows" });
        const script = join(f.home, "windows.mjs");
        writeFileSync(script, invokeCode + `
if(hook('SessionStart',{source:'startup'}).status)throw new Error('startup');
for(let i=0;i<2;i++){const r=hook('SessionStart',{source:'compact',turn_id:'same-turn'});if(r.status)throw new Error(r.stderr);}
`);
        const r = await launch(f.cfg, { work: w.result.id, runtime: "codex", cwd: f.repo, argv: [process.execPath, script] });
        assert.equal(r.exitCode, 0);
        assert.equal(Object.values(f.server.workspace.store.snapshot().runs)[0]!.windows.length, 2);
    }
    finally {
        await f.close();
    }
});
test("init reports an edited Git hook without overwriting it", async () => {
    const home = mkdtempSync(join(tmpdir(), "wr-next-git-drift-"));
    try {
        spawnSync("git", ["init", "-q", home]);
        const options = { cwd: home, env: { ...process.env, WR_NEXT_HOME: join(home, "state") } };
        assert.equal((await exec(["init", "--runtime", "claude"], options)).code, 0);
        const hook = join(home, ".git/hooks/post-commit"), edited = readFileSync(hook, "utf8") + "\n# user edit\n";
        writeFileSync(hook, edited);
        const out = await exec(["init"], options);
        assert.equal(out.code, 2);
        assert.equal(JSON.parse(out.stdout).gitHooks.state, "manual-action-required");
        assert.equal(readFileSync(hook, "utf8"), edited);
    }
    finally {
        rmSync(home, { recursive: true, force: true });
    }
});
