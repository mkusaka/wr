import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { join, resolve, delimiter } from "node:path";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { startLocal } from "../src/server/local.js";
import { Client } from "../src/cli/client.js";
import { atomic, type Connection } from "../src/cli/files.js";
import { CoordinatorBridge } from "../src/runtime/coordinator.js";
import { registrationPath, type AgentRegistration } from "../src/cli/coordination.js";
import { managementCommand } from "../src/integrations/runtime/coordinator-hook.js";
const cli = resolve("dist/src/cli/main.js");
const bin = resolve("bin");
const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
type CommandResult = {
    code: number;
    stdout: string;
    stderr: string;
};
type CliFixture = {
    cli(args: string[], env?: NodeJS.ProcessEnv): Promise<CommandResult>;
};
function run(argv: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<CommandResult> {
    return new Promise((res, rej) => {
        const child = spawn(process.execPath, argv, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "", stderr = "";
        child.stdout.on("data", b => stdout += b);
        child.stderr.on("data", b => stderr += b);
        child.on("error", rej);
        child.on("close", code => res({ code: code ?? 1, stdout, stderr }));
    });
}
async function fixture() {
    const home = mkdtempSync(join(tmpdir(), "wr-coordinator-cli-")), repo = join(home, "repo");
    const git = spawnSync("git", ["init", "-q", repo]);
    assert.equal(git.status, 0);
    const oldHome = process.env.WR_NEXT_HOME;
    process.env.WR_NEXT_HOME = home;
    const server = await startLocal({ database: join(home, "db.sqlite") });
    const cfg: Connection = { server: server.url, workspace: "local", device: "coordinator-cli", token: server.secret };
    atomic(join(home, "connection.json"), cfg);
    const env: NodeJS.ProcessEnv = { ...process.env, WR_NEXT_HOME: home, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` };
    for (const name of ["WR_NEXT_CONTEXT", "WR_NEXT_COORDINATOR", "WR_NEXT_COORDINATOR_TOOL", "WR_NEXT_BINDING_REQUIRED", "WR_NEXT_RUNTIME_AGENT", "WR_NEXT_RUNTIME_KIND"])
        delete env[name];
    return { home, repo, server, cfg, client: new Client(cfg), env,
        cli: (args: string[], e = env) => run([cli, ...args], repo, e),
        close: async () => {
            await server.close();
            rmSync(home, { recursive: true, force: true });
            if (oldHome === undefined)
                delete process.env.WR_NEXT_HOME;
            else
                process.env.WR_NEXT_HOME = oldHome;
        }
    };
}
async function init(f: CliFixture, managed = true, runtime: "claude" | "codex" | "omp" = "claude") {
    const result = await f.cli(["init", "--runtime", runtime, "--no-git-hooks", ...(managed ? ["--agent-managed"] : [])]);
    assert.equal(result.code, 0, result.stderr);
    return JSON.parse(result.stdout);
}
/** Real descendant OS processes execute the generated static hook commands. No provider/model calls. */
function fakeClaude(f: {
    repo: string;
}, commands: string[], options: {
    compact?: boolean;
    extra?: Record<string, unknown>;
    raw?: unknown;
    denyAt?: number;
    denialHook?: "PermissionDenied" | "PostToolBatch";
    runtime?: "claude" | "codex";
} = {}) {
    const runtime = options.runtime ?? "claude";
    const file = join(f.repo, runtime);
    const settingsPath = runtime === "claude" ? ".claude/settings.json" : ".codex/hooks.json";
    writeFileSync(file, `
const {readFileSync}=require('node:fs'); const {spawn}=require('node:child_process');
const settings=JSON.parse(readFileSync(${JSON.stringify(settingsPath)},'utf8'));
const runtime=${JSON.stringify(runtime)}; const commands=${JSON.stringify(commands)}; const calls=[];
function exec(command,input){return new Promise((resolve,reject)=>{const p=spawn('/bin/sh',['-c',command],{env:process.env,stdio:['pipe','pipe','pipe']});let out='',err='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);p.on('error',reject);p.on('close',code=>resolve({code,out,err}));p.stdin.end(input??'');});}
async function hook(name,fields={}){ const command=settings.hooks[name]?.[0]?.hooks?.[0]?.command;if(!command)throw new Error('missing hook '+name);const result=await exec(command,JSON.stringify({cwd:process.cwd(),session_id:'fixture-session',hook_event_name:name,...fields})); return {...result,json:result.out.trim()?JSON.parse(result.out):{}}; }
(async()=>{
 const start=await hook('SessionStart',{source:'startup'});calls.push({name:'start',...start});
 ${options.compact ? "calls.push({name:'compact',...await hook('SessionStart',{source:'compact',event_id:'same-window'})});" : ""}
 for(let i=0;i<commands.length;i++){const command=commands[i], id='tool-'+i;const pre=await hook('PreToolUse',{tool_name:'Bash',tool_use_id:id,tool_input:{command},...${JSON.stringify(options.extra ?? {})}}); const denied=pre.code!==0||pre.json.hookSpecificOutput?.permissionDecision==='deny';
 if(denied){calls.push({name:'denied',command,pre});continue;}
 if(i===${JSON.stringify(options.denyAt ?? -1)}){const post=await hook(${JSON.stringify(options.denialHook ?? "PostToolBatch")},{tool_name:'Bash',tool_use_id:id,tool_calls:[{tool_name:'Bash',tool_use_id:id,tool_response:'Permission denied'}]});calls.push({name:'permission-denied',command,pre,post});continue;}
 const result=await exec(pre.json.hookSpecificOutput?.updatedInput?.command??command);const post=await hook(runtime==='claude'&&result.code!==0?'PostToolUseFailure':'PostToolUse',{tool_name:'Bash',tool_use_id:id,tool_input:{command},tool_response:{stdout:result.out,is_error:result.code!==0}}); calls.push({name:'tool',command,pre,result,post}); }
 calls.push({name:'end',...await hook('SessionEnd')}); console.log(JSON.stringify(calls));
})().catch(e=>{console.error(e.stack);process.exitCode=1;});`);
    return file;
}
function fakeClaudeChild(f: {
    repo: string;
}) {
    const file = join(f.repo, "claude");
    writeFileSync(file, `
const {readFileSync}=require('node:fs'); const {spawn}=require('node:child_process');
const settings=JSON.parse(readFileSync('.claude/settings.json','utf8'));
function exec(command){const {promise,resolve,reject}=Promise.withResolvers();const p=spawn('/bin/sh',['-c',command],{env:process.env,stdio:['ignore','pipe','pipe']});let out='',err='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);p.on('error',reject);p.on('close',code=>resolve({code:code??1,out,err}));return promise;}
async function hook(name,fields={}){const command=settings.hooks[name][0].hooks[0].command;const p=spawn('/bin/sh',['-c',command],{env:process.env,stdio:['pipe','pipe','pipe']});let out='',err='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);const {promise,resolve}=Promise.withResolvers();p.on('close',code=>resolve({code:code??1,out,err}));p.stdin.end(JSON.stringify({cwd:process.cwd(),session_id:'native-session',hook_event_name:name,...fields}));const result=await promise;return {...result,json:result.out.trim()?JSON.parse(result.out):{}};}
async function rootBash(id,command){const pre=await hook('PreToolUse',{prompt_id:'root-turn',tool_name:'Bash',tool_use_id:id,tool_input:{command}});if(pre.json.hookSpecificOutput?.permissionDecision==='deny')throw new Error(pre.json.hookSpecificOutput.permissionDecisionReason);const result=await exec(pre.json.hookSpecificOutput.updatedInput.command);await hook(result.code===0?'PostToolUse':'PostToolUseFailure',{prompt_id:'root-turn',tool_name:'Bash',tool_use_id:id,tool_input:{command},tool_response:{stdout:result.out,is_error:result.code!==0}});if(result.code!==0)throw new Error(result.err);return result;}
(async()=>{
await hook('SessionStart',{source:'startup'});
const added=JSON.parse((await rootBash('add',"wr-next add 'Child review'")).out);
const delegated=JSON.parse((await rootBash('delegate',\`wr-next delegate \${added.result.id} --role reviewer --read-only\`)).out);
const missing=await hook('PreToolUse',{prompt_id:'missing-turn',tool_name:'Agent',tool_use_id:'missing-agent',tool_input:{prompt:'No assignment\\nReview'}});if(missing.json.hookSpecificOutput?.permissionDecision!=='deny')throw new Error('unassigned native spawn was not denied');
const agentInput={description:'Review child',subagent_type:'Explore',prompt:delegated.spawnDirective+'\\nReview the assigned work and submit a result.'};
const agentPre=await hook('PreToolUse',{prompt_id:'child-turn',tool_name:'Agent',tool_use_id:'agent-tool',tool_input:agentInput});
if(agentPre.json.hookSpecificOutput?.permissionDecision==='deny')throw new Error(agentPre.json.hookSpecificOutput.permissionDecisionReason);
const started=await hook('SubagentStart',{prompt_id:'child-turn',agent_id:'child-1',agent_type:'Explore'});
if(!started.json.hookSpecificOutput?.additionalContext?.includes('working on'))throw new Error('child assignment guidance missing: '+JSON.stringify(started));
const childWrite=await hook('PreToolUse',{prompt_id:'child-turn',agent_id:'child-1',agent_type:'Explore',tool_name:'Bash',tool_use_id:'child-write',tool_input:{command:'printf forbidden'}});
if(childWrite.json.hookSpecificOutput?.permissionDecision!=='deny')throw new Error('read-only child arbitrary shell was not denied');
const command="wr-next done --summary 'Native review completed'";
const childPre=await hook('PreToolUse',{prompt_id:'child-turn',agent_id:'child-1',agent_type:'Explore',tool_name:'Bash',tool_use_id:'child-tool',tool_input:{command}});
if(childPre.json.hookSpecificOutput?.permissionDecision==='deny')throw new Error(childPre.json.hookSpecificOutput.permissionDecisionReason);
const childResult=await exec(childPre.json.hookSpecificOutput.updatedInput.command);
await hook(childResult.code===0?'PostToolUse':'PostToolUseFailure',{prompt_id:'child-turn',agent_id:'child-1',agent_type:'Explore',tool_name:'Bash',tool_use_id:'child-tool',tool_input:{command},tool_response:{stdout:childResult.out,is_error:childResult.code!==0}});
const rogueStart=await hook('SubagentStart',{prompt_id:'rogue-turn',agent_id:'rogue-child',agent_type:'Explore'});
const roguePre=await hook('PreToolUse',{prompt_id:'rogue-turn',agent_id:'rogue-child',agent_type:'Explore',tool_name:'Bash',tool_use_id:'rogue-tool',tool_input:{command:'wr-next status'}});
if(roguePre.json.hookSpecificOutput?.permissionDecision!=='deny')throw new Error('observed unassigned child tool was not denied');
await hook('SubagentStop',{prompt_id:'rogue-turn',agent_id:'rogue-child',agent_type:'Explore',last_assistant_message:'Unassigned'});
await hook('SubagentStop',{prompt_id:'child-turn',agent_id:'child-1',agent_type:'Explore',last_assistant_message:'Finished'});
await hook('PostToolUse',{prompt_id:'root-turn',tool_name:'Agent',tool_use_id:'agent-tool',tool_input:agentInput,tool_response:{stdout:'Finished',is_error:false}});
console.log(JSON.stringify({added,delegated,missing,started,childWrite,childPre,childResult,rogueStart,roguePre}));
})().catch(error=>{console.error(error.stack);process.exitCode=1});`);
    return file;
}
function fakeOmp(f: {
    repo: string;
}, commands: string[]) {
    const file = join(f.repo, "omp");
    writeFileSync(file, `
const {spawnSync}=require('node:child_process');
function exec(command){const result=spawnSync('/bin/sh',['-c',command],{env:process.env,encoding:'utf8'});return {code:result.status??1,out:result.stdout??'',err:result.stderr??''};}
(async()=>{
// This generated host intentionally loads the generated project extension through OMP's runtime-discovery boundary.
const {default:install}=await import('./.omp/extensions/wr-next.ts');const handlers=new Map();install({on:(name,handler)=>handlers.set(name,handler)});
const ctx={cwd:process.cwd(),sessionManager:{getSessionId:()=> 'fixture-session'},ui:{notify:(message)=>{throw new Error(message)}}};
await handlers.get('session_start')({},ctx);const prompt=await handlers.get('before_agent_start')({},ctx);if(!prompt?.message?.content?.includes('coordinate work'))throw new Error('coordinator guidance missing');
const calls=[];for(let i=0;i<${JSON.stringify(commands)}.length;i++){const command=${JSON.stringify(commands)}[i],toolCallId='tool-'+i,input={command};const decision=await handlers.get('tool_call')({toolName:'bash',toolCallId,input},ctx);if(decision?.block)throw new Error(decision.reason);const actual=decision?.input?.command??command;const result=exec(actual);await handlers.get('tool_result')({toolName:'bash',toolCallId,input:decision?.input??input,isError:result.code!==0,content:[{type:'text',text:result.out||result.err}]},ctx);calls.push({command,actual,result});}
await handlers.get('session_shutdown')({},ctx);console.log(JSON.stringify(calls));})().catch(error=>{console.error(error.stack);process.exitCode=1});`);
    return file;
}
test("explicit init creates private enrollment; static init alone grants nothing", async () => {
    const f = await fixture();
    try {
        await init(f, false);
        assert.equal(Object.keys(f.server.workspace.store.snapshot().coordinationGrants).length, 0);
        const configBefore = readFileSync(join(f.repo, ".wr/config.json"), "utf8");
        const result = await init(f);
        assert.equal(result.management.enabled, true);
        assert.equal(readFileSync(join(f.repo, ".wr/config.json"), "utf8"), configBefore);
        const state = f.server.workspace.store.snapshot();
        assert.equal(Object.keys(state.executions).length, 0);
        assert.equal(Object.keys(state.coordinators).length, 0);
        assert.equal(Object.values(state.work)[0]!.collection, true);
        assert.ok(!JSON.stringify(result).includes("wn1."));
    }
    finally {
        await f.close();
    }
});
test("trusted bridge tool CLI plans, claims, reports and submits without work IDs", async () => {
    const f = await fixture();
    try {
        await init(f);
        const grant = JSON.parse(readFileSync(registrationPath(f.repo), "utf8")) as AgentRegistration;
        const bridge = await CoordinatorBridge.open(grant.bootstrap, { runtime: "claude", session: "direct", actor: "root", invocation: "actual-1", environment: grant.environment });
        async function tool(id: string, args: string[]) { const env = await bridge.toolEnvironment(id, { args }, f.env); const result = await f.cli(args, env); await bridge.toolFinished(id); assert.equal(result.code, 0, result.stderr); return result; }
        await tool("create", ["plan", "--changes", JSON.stringify([{ type: "work.create", title: "First", priority: 8 }, { type: "work.create", title: "Second", priority: 1 }])]);
        assert.equal(Object.keys(f.server.workspace.store.snapshot().executions).length, 0);
        await tool("note", ["report", "--decision", "Follow the new user request", "--reason", "Not unrelated ready backlog"]);
        const claim = await tool("claim", ["next", "--claim"]);
        assert.equal(JSON.parse(claim.stdout).title, "First");
        assert.ok(!claim.stdout.includes("wn1."));
        await tool("report", ["report", "--progress", "In progress"]);
        await tool("done", ["done", "--summary", "First submitted"]);
        assert.equal(Object.values(f.server.workspace.store.snapshot().executions)[0]!.state, "finished");
        const second = await tool("claim2", ["next", "--claim"]);
        assert.equal(JSON.parse(second.stdout).title, "Second");
        await tool("done2", ["done", "--summary", "Second submitted"]);
        const state = f.server.workspace.store.snapshot();
        assert.equal(Object.keys(state.runs).length, 1);
        assert.equal(Object.keys(state.executions).length, 2);
        assert.ok(Object.values(state.reservations).some(r => r.state === "active"));
        await bridge.stop(true);
        assert.ok(Object.values(f.server.workspace.store.snapshot().reservations).every(r => r.state === "released"));
    }
    finally {
        await f.close();
    }
});
test("plain Claude process uses actual installed hooks and per-tool contexts without launcher", async () => {
    const f = await fixture();
    try {
        await init(f);
        const fake = fakeClaude(f, ["wr-next status --json", "wr-next add 'A new user request'", "printf forbidden-before-claim", "wr-next next --claim", "wr-next report --decision 'Use existing API' --reason 'Meet user request'", "wr-next done --summary 'Task submitted'", "wr-next next --claim"], { compact: true });
        const result = await run([fake], f.repo, f.env);
        assert.equal(result.code, 0, result.stderr);
        const calls = JSON.parse(result.stdout) as any[];
        assert.equal(calls[0].code, 0, calls[0].err);
        assert.match(calls[0].json.hookSpecificOutput.additionalContext, /coordinate work/);
        assert.equal(calls.filter(c => c.name === "denied").length, 1);
        for (const c of calls.filter(c => c.name === "tool")) {
            assert.equal(c.result.code, 0, c.result.err);
            assert.equal(c.post.code, 0, c.post.err);
            assert.equal(c.pre.json.hookSpecificOutput.permissionDecision, undefined);
        }
        const last = calls.filter(c => c.name === "tool").at(-1);
        assert.equal(JSON.parse(last.result.out).idle, true);
        const state = f.server.workspace.store.snapshot();
        assert.equal(Object.keys(state.runs).length, 1);
        assert.equal(Object.keys(state.executions).length, 1);
        assert.equal(Object.values(state.runs)[0]!.windows.length, 1);
        assert.equal(Object.values(state.work).find(w => w.title === "A new user request")!.state, "done");
        assert.equal(Object.values(state.runs)[0]!.state, "unknown"); // SessionEnd is advisory.
        assert.ok(!result.stdout.includes("wn1."));
    }
    finally {
        await f.close();
    }
});
test("plain Claude binds one explicitly delegated native child without parent context inheritance", async () => {
    const f = await fixture();
    try {
        await init(f);
        const fake = fakeClaudeChild(f);
        const result = await run([fake], f.repo, f.env);
        assert.equal(result.code, 0, result.stderr);
        const output = JSON.parse(result.stdout) as {
            missing: {
                json: {
                    hookSpecificOutput: {
                        permissionDecision: string;
                    };
                };
            };
            started: {
                json: {
                    hookSpecificOutput: {
                        additionalContext: string;
                    };
                };
            };
            childPre: {
                json: {
                    hookSpecificOutput: {
                        updatedInput: {
                            command: string;
                        };
                    };
                };
            };
            childWrite: {
                json: {
                    hookSpecificOutput: {
                        permissionDecision: string;
                    };
                };
            };
            childResult: CommandResult;
            roguePre: {
                json: {
                    hookSpecificOutput: {
                        permissionDecision: string;
                    };
                };
            };
        };
        assert.equal(output.missing.json.hookSpecificOutput.permissionDecision, "deny");
        assert.match(output.started.json.hookSpecificOutput.additionalContext, /working on/i);
        assert.equal(output.childWrite.json.hookSpecificOutput.permissionDecision, "deny");
        assert.equal(output.roguePre.json.hookSpecificOutput.permissionDecision, "deny");
        assert.match(output.childPre.json.hookSpecificOutput.updatedInput.command, /WR_NEXT_CONTEXT=/);
        assert.equal(output.childResult.code, 0, output.childResult.stderr);
        const state = f.server.workspace.store.snapshot();
        const work = Object.values(state.work).find(item => item.title === "Child review")!;
        const child = Object.values(state.runtimeAgents).find(agent => agent.externalAgentId === "child-1")!;
        const rogue = Object.values(state.runtimeAgents).find(agent => agent.externalAgentId === "rogue-child")!;
        assert.equal(work.state, "done");
        assert.equal(child.parent, Object.values(state.runtimeAgents).find(agent => agent.parent === null)!.id);
        assert.ok(child.execution);
        assert.equal(state.executions[child.execution!]!.work, work.id);
        assert.equal(rogue.execution, null);
        assert.ok(Object.values(state.dispatches).every(dispatch => dispatch.state === "closed"));
        assert.deepEqual(readdirSync(join(f.home, "assignments")), []);
    }
    finally {
        await f.close();
    }
});
test("plain Codex process coordinates through installed hooks and preserves rewritten-input approval", async () => {
    const f = await fixture();
    try {
        await init(f, true, "codex");
        const fake = fakeClaude(f, ["wr-next add 'Codex request'", "wr-next next --claim", "wr-next report --progress 'Codex working'", "wr-next done --summary 'Codex submitted'"], { runtime: "codex" });
        const result = await run([fake], f.repo, f.env);
        assert.equal(result.code, 0, result.stderr);
        assert.match(result.stdout, /"permissionDecision":"allow"/);
        assert.match(result.stdout, /WR_NEXT_COORDINATOR_TOOL/);
        const state = f.server.workspace.store.snapshot();
        assert.equal(Object.values(state.work).find(work => work.title === "Codex request")!.state, "done");
        assert.equal(Object.values(state.runs)[0]!.runtime, "codex");
        assert.ok(Object.values(state.dispatches).every(dispatch => dispatch.state === "closed"));
    }
    finally {
        await f.close();
    }
});
test("plain OMP process coordinates through its project extension and revised tool input", async () => {
    const f = await fixture();
    try {
        await init(f, true, "omp");
        const fake = fakeOmp(f, ["wr-next add 'OMP request'", "wr-next next --claim", "wr-next report --progress 'OMP working'", "wr-next done --summary 'OMP submitted'"]);
        const result = await run([fake], f.repo, f.env);
        assert.equal(result.code, 0, result.stderr);
        assert.match(result.stdout, /WR_NEXT_COORDINATOR_TOOL/);
        const state = f.server.workspace.store.snapshot();
        assert.equal(Object.values(state.work).find(work => work.title === "OMP request")!.state, "done");
        assert.equal(Object.values(state.runs)[0]!.runtime, "omp");
        assert.ok(Object.values(state.dispatches).every(dispatch => dispatch.state === "closed"));
    }
    finally {
        await f.close();
    }
});
test("unregistered ambient runtime hooks do not create authority/session/work", async () => {
    const f = await fixture();
    try {
        await init(f, false);
        const fake = fakeClaude(f, []);
        const result = await run([fake], f.repo, f.env);
        assert.equal(result.code, 0, result.stderr);
        assert.equal(Object.keys(f.server.workspace.store.snapshot().coordinators).length, 0);
        assert.equal(Object.keys(f.server.workspace.store.snapshot().work).length, 0);
    }
    finally {
        await f.close();
    }
});
test("inherited native child identity cannot claim root work through the permanent hook", async () => {
    const f = await fixture();
    try {
        await init(f);
        const fake = fakeClaude(f, ["wr-next next --claim"], { extra: { agent_id: "native-child" } });
        const result = await run([fake], f.repo, f.env);
        assert.equal(result.code, 0, result.stderr);
        const calls = JSON.parse(result.stdout);
        assert.equal(calls.find((c: any) => c.name === "denied").pre.json.hookSpecificOutput.permissionDecision, "deny");
        assert.equal(Object.keys(f.server.workspace.store.snapshot().executions).length, 0);
    }
    finally {
        await f.close();
    }
});
test("managed coordinator without work cannot fall back to operator or mutate enrollment", async () => {
    const f = await fixture();
    try {
        await init(f);
        const reg = JSON.parse(readFileSync(registrationPath(f.repo), "utf8")) as AgentRegistration;
        const bridge = await CoordinatorBridge.open(reg.bootstrap, { runtime: "claude", session: "direct", actor: "root", invocation: "policy", environment: reg.environment });
        for (const args of [["authority", "stop"], ["serve"], ["init", "--agent-managed"], ["hooks", "uninstall"], ["management", "disable"], ["done", "--summary", "no assignment"]]) {
            const id = args.join("-"), env = await bridge.toolEnvironment(id, { args }, f.env);
            const result = await f.cli(args, env);
            assert.notEqual(result.code, 0, args.join(" "));
            await bridge.toolFinished(id);
        }
        const bad = await f.cli(["add", "must not become operator"], { ...f.env, WR_NEXT_COORDINATOR: "/missing", WR_NEXT_COORDINATOR_TOOL: "/missing" });
        assert.notEqual(bad.code, 0);
        assert.equal(Object.keys(f.server.workspace.store.snapshot().work).length, 1);
    }
    finally {
        await f.close();
    }
});
test("management shell guard rejects expanding/chained commands but permits inline JSON plans", () => {
    for (const cmd of ["wr-next next --claim; rm -rf /tmp/x", "wr-next status $(id)", "wr-next status >x", "wr-next add \"$(id)\"", "git diff --output=/tmp/x", "cat file", "WR_NEXT_TOKEN=bad wr-next status"])
        assert.equal(managementCommand(cmd), false, cmd);
    for (const cmd of ["wr-next next --claim", `wr-next plan --changes ${q(JSON.stringify([{ type: "work.create", title: "A&B" }]))}`, "git status --short", "pwd"])
        assert.equal(managementCommand(cmd), true, cmd);
});
test("missing tool context cannot use coordinator root capability for implicit work selection", async () => {
    const f = await fixture();
    try {
        await init(f);
        const reg = JSON.parse(readFileSync(registrationPath(f.repo), "utf8")) as AgentRegistration;
        const bridge = await CoordinatorBridge.open(reg.bootstrap, { runtime: "claude", session: "no-slot", actor: "root", invocation: "once", environment: reg.environment });
        const result = await f.cli(["next", "--claim"], { ...f.env, WR_NEXT_COORDINATOR: bridge.contextFile });
        assert.notEqual(result.code, 0);
        assert.match(result.stderr, /UNBOUND_COORDINATOR/);
        assert.equal(Object.keys(f.server.workspace.store.snapshot().executions).length, 0);
        assert.ok(readdirSync(join(f.home, "coordinators")).length === 1);
    }
    finally {
        await f.close();
    }
});
test("run --next atomically selects without a Work ID and does not spawn when no work is ready", async () => {
    const f = await fixture();
    try {
        await init(f);
        await f.cli(["add", "Explicit human task, scoped to repository"]);
        const ready = await f.cli(["ready"]);
        assert.equal(ready.code, 0, ready.stderr);
        assert.equal(JSON.parse(ready.stdout).ready.length, 1);
        const first = await f.cli(["run", "--next", "--runtime", "generic", "--", process.execPath, "-e", "const {spawnSync}=require('node:child_process');process.exitCode=spawnSync('wr-next',['done','--summary','one-shot done'],{stdio:'inherit'}).status"]);
        assert.equal(first.code, 0, first.stderr);
        assert.equal(Object.keys(f.server.workspace.store.snapshot().executions).length, 1);
        const next = await f.cli(["run", "--next", "--runtime", "generic", "--", "/this-must-not-be-spawned"]);
        assert.equal(next.code, 0, next.stderr);
        assert.equal(JSON.parse(next.stdout).idle, true);
        assert.equal(Object.keys(f.server.workspace.store.snapshot().executions).length, 1);
    }
    finally {
        await f.close();
    }
});
test("repeated CLI invocation in a tool retains the original atomic plan receipt", async () => {
    const f = await fixture();
    try {
        await init(f);
        const reg = JSON.parse(readFileSync(registrationPath(f.repo), "utf8")) as AgentRegistration;
        const bridge = await CoordinatorBridge.open(reg.bootstrap, { runtime: "claude", session: "retry", actor: "root", invocation: "once", environment: reg.environment });
        const args = ["plan", "--changes", JSON.stringify([{ type: "work.create", title: "exactly once" }])], env = await bridge.toolEnvironment("retry-tool", { args }, f.env);
        const a = await f.cli(args, env), b = await f.cli(args, env);
        assert.equal(a.code, 0, a.stderr);
        assert.equal(b.code, 0, b.stderr);
        assert.deepEqual(JSON.parse(a.stdout), JSON.parse(b.stdout));
        assert.equal(Object.values(f.server.workspace.store.snapshot().work).filter(w => w.title === "exactly once").length, 1);
        await bridge.toolFinished("retry-tool");
    }
    finally {
        await f.close();
    }
});
test("child CLI inheriting coordinator markers cannot bootstrap another root", async () => {
    const f = await fixture();
    try {
        await init(f);
        const fake = fakeClaude(f, ["wr-next next --claim"]);
        const result = await run([fake], f.repo, { ...f.env, WR_NEXT_COORDINATOR: "/inherited-parent", WR_NEXT_COORDINATOR_TOOL: "/inherited-tool" });
        assert.equal(result.code, 0, result.stderr);
        assert.equal(Object.keys(f.server.workspace.store.snapshot().coordinators).length, 0);
        assert.equal(JSON.parse(result.stdout).filter((x: any) => x.name === "denied").length, 1);
    }
    finally {
        await f.close();
    }
});
test("failed tool hook closes its dispatch, rather than leaving every later claim blocked", async () => {
    const f = await fixture();
    try {
        await init(f);
        const fake = fakeClaude(f, ["wr-next claim not-found", "wr-next add 'Recover after command failure'", "wr-next next --claim", "wr-next done --summary 'recovered'"]);
        const out = await run([fake], f.repo, f.env);
        assert.equal(out.code, 0, out.stderr);
        const calls = JSON.parse(out.stdout).filter((x: any) => x.name === "tool");
        assert.notEqual(calls[0].result.code, 0);
        for (const c of calls.slice(1))
            assert.equal(c.result.code, 0, c.result.err);
        assert.ok(Object.values(f.server.workspace.store.snapshot().dispatches).every(d => d.state === "closed"));
    }
    finally {
        await f.close();
    }
});
test("agent-claimed commit uses the exact execution context through permanent Git hooks", async () => {
    const f = await fixture();
    try {
        await init(f);
        for (const args of [["config", "user.name", "Synthetic Worker"], ["config", "user.email", "test@example.invalid"]])
            assert.equal(spawnSync("git", args, { cwd: f.repo }).status, 0);
        const hooks = await f.cli(["hooks", "install"]);
        assert.equal(hooks.code, 0, hooks.stderr);
        const fake = fakeClaude(f, ["wr-next add 'Commit the implementation'", "wr-next next --claim", "printf 'tested implementation\\n' > implementation.txt && git add implementation.txt && git -c commit.gpgsign=false commit -m 'Implement synthetic work'", "wr-next done --summary 'Committed implementation'"]);
        const output = await run([fake], f.repo, f.env);
        assert.equal(output.code, 0, output.stderr);
        for (const t of JSON.parse(output.stdout).filter((x: any) => x.name === "tool")) {
            assert.equal(t.result.code, 0, t.result.err);
            assert.equal(t.post.code, 0, t.post.err);
        }
        const state = f.server.workspace.store.snapshot(), execution = Object.values(state.executions)[0]!;
        assert.equal(Object.keys(state.artifacts).length, 1);
        const artifact = Object.values(state.artifacts)[0]!;
        assert.deepEqual(artifact.gaps, []);
        assert.ok(artifact.context);
        assert.equal(state.contexts[artifact.context!]!.snapshot.execution, execution.id);
        assert.equal(Object.values(state.results)[0]!.execution, execution.id);
        assert.equal(Object.values(state.results)[0]!.manifest[0]!.sha, artifact.sha);
        const message = spawnSync("git", ["log", "-1", "--format=%B"], { cwd: f.repo, encoding: "utf8" }).stdout;
        assert.match(message, /WR-Work:/);
        assert.match(message, /WR-Context:/);
        assert.ok(!message.includes("wn1."));
    }
    finally {
        await f.close();
    }
});
test("approved plain startup reuses its original database after authority restart and reaps dead root only", async () => {
    const home = mkdtempSync(join(tmpdir(), "wr-coordinator-autostart-")), repo = join(home, "repo");
    assert.equal(spawnSync("git", ["init", "-q", repo]).status, 0);
    const env: NodeJS.ProcessEnv = { ...process.env, WR_NEXT_HOME: home, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` };
    for (const name of ["WR_NEXT_CONTEXT", "WR_NEXT_COORDINATOR", "WR_NEXT_COORDINATOR_TOOL", "WR_NEXT_BINDING_REQUIRED", "WR_NEXT_RUNTIME_AGENT", "WR_NEXT_RUNTIME_KIND"])
        delete env[name];
    const cmd = (args: string[]) => run([cli, ...args], repo, env);
    try {
        const setup = await cmd(["init", "--runtime", "claude", "--no-git-hooks", "--agent-managed"]);
        assert.equal(setup.code, 0, setup.stderr);
        const before = JSON.parse(readFileSync(join(home, "connection.json"), "utf8")) as Connection;
        const first = fakeClaude({ repo }, ["wr-next add 'First before restart'", "wr-next next --claim", "wr-next done --summary 'submitted first'"]);
        const a = await run([first], repo, env);
        assert.equal(a.code, 0, a.stderr);
        for (const t of JSON.parse(a.stdout).filter((x: any) => x.name === "tool"))
            assert.equal(t.result.code, 0, t.result.err);
        const stopped = await cmd(["authority", "stop"]);
        assert.equal(stopped.code, 0, stopped.stderr);
        const second = fakeClaude({ repo }, ["wr-next add 'Second after restart'", "wr-next next --claim", "wr-next done --summary 'submitted second'"]);
        const b = await run([second], repo, env);
        assert.equal(b.code, 0, b.stderr);
        for (const t of JSON.parse(b.stdout).filter((x: any) => x.name === "tool"))
            assert.equal(t.result.code, 0, t.result.err);
        const after = JSON.parse(readFileSync(join(home, "connection.json"), "utf8")) as Connection;
        assert.equal(after.token, before.token);
        assert.equal(after.localAuthority!.database, before.localAuthority!.database);
        const state = await new Client(after).request<any>("/v1/snapshot");
        assert.equal(Object.keys(state.coordinators).length, 2);
        assert.equal(Object.values(state.work).filter((w: any) => w.state === "done").length, 2);
        const runs = Object.values(state.runs) as any[];
        assert.equal(runs.filter(r => r.state === "ended").length, 1);
        assert.equal(runs.filter(r => r.state === "unknown").length, 1);
    }
    finally {
        await cmd(["authority", "stop"]);
        rmSync(home, { recursive: true, force: true });
    }
});
test("permission refusal and resolved batch retire only the denied tool, without fake acceptance", async () => {
    for (const denialHook of ["PermissionDenied", "PostToolBatch"] as const) {
        const f = await fixture();
        try {
            await init(f);
            const fake = fakeClaude(f, ["wr-next add 'Denied work'", "wr-next add 'Allowed work'", "wr-next next --claim", "wr-next done --summary 'submitted'"], { denyAt: 0, denialHook });
            const out = await run([fake], f.repo, f.env);
            assert.equal(out.code, 0, out.stderr);
            const calls = JSON.parse(out.stdout);
            for (const c of calls.filter((x: any) => x.name === "tool")) {
                assert.equal(c.result.code, 0, c.result.err);
                assert.equal(c.post.code, 0, c.post.err);
            }
            assert.equal(Object.values(f.server.workspace.store.snapshot().work).some(w => w.title === "Denied work"), false);
            assert.equal(Object.values(f.server.workspace.store.snapshot().results).length, 1);
            assert.ok(Object.values(f.server.workspace.store.snapshot().dispatches).every(d => d.state === "closed"));
        }
        finally {
            await f.close();
        }
    }
});
