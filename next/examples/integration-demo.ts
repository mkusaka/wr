/** Local proof only: real processes/Git/SQLite; normalized GitHub data is synthetic. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { startLocal } from "../src/server/local.js";
import { Client } from "../src/cli/client.js";
import { atomic } from "../src/cli/files.js";
import { git, head, repository } from "../src/git/repository.js";
import { installHooks, uninstallHooks } from "../src/git/hooks.js";
import { launch } from "../src/runtime/launcher.js";
import { parseChecklist, legacyReadiness } from "../src/importers/checklist.js";
import { reasons } from "../src/domain/work.js";
import { mermaid, workpad, type View } from "../src/projections/views.js";
const directory = mkdtempSync(join(tmpdir(), "wr-next-proof-")), oldHome = process.env.WR_NEXT_HOME, oldContext = process.env.WR_NEXT_CONTEXT;
process.env.WR_NEXT_HOME = join(directory, "state");
delete process.env.WR_NEXT_CONTEXT;
const checkout = join(directory, "checkout");
mkdirSync(checkout);
const server = await startLocal({ database: join(directory, "workspace.sqlite") });
const cfg = { server: server.url, workspace: "local", device: "local-proof", token: server.secret }, client = new Client(cfg);
atomic(join(process.env.WR_NEXT_HOME, "connection.json"), cfg);
try {
    git(checkout, ["init", "-b", "main"]);
    git(checkout, ["config", "user.name", "Synthetic developer"]);
    git(checkout, ["config", "user.email", "developer@example.invalid"]);
    git(checkout, ["remote", "add", "origin", "https://github.com/example/wr-next-proof.git"]);
    writeFileSync(join(checkout, "sum.cjs"), "module.exports=(a,b)=>0;\n");
    git(checkout, ["add", "sum.cjs"]);
    git(checkout, ["commit", "-m", "initial synthetic fixture"]);
    installHooks(checkout);
    const input = `# Synthetic local proof\n## [ ] No.1 ImplementSum\n- state: implementation\n- stage: implementation\n- writes: sum.cjs\n- run: idle\n## [ ] No.2 ReviewSum\n- state: implementation\n- stage: implementation\n- writes: review.txt\n- needs: No.1\n- run: idle\n`;
    const imported = parseChecklist(input, "local-proof");
    assert.equal(imported.errors.length, 0);
    const { errors: _errors, warnings: _warnings, ...data } = imported;
    const source = (await client.command({ type: "import.apply", ...data })).result;
    const before = server.workspace.store.snapshot(), old = legacyReadiness(imported), differences: string[] = [];
    for (const [key, id] of Object.entries(source.mapping as Record<string, string>))
        if ((old[key]!.length === 0) !== (reasons(before, before.work[id]!).length === 0))
            differences.push(key);
    assert.deepEqual(differences, []);
    const root = before.work[source.root]!;
    await client.command({ type: "migration.mode", source: source.id, mode: "next", confirm: root.key, comparison: { revision: before.meta.revision, sourceDigest: source.digest, differences } });
    const first = source.mapping["1"] as string, second = source.mapping["2"] as string;
    await client.command({ type: "work.update", work: first, policy: { name: "evidence-v1", checks: ["tests"] }, replan: true });
    const program = `const {writeFileSync}=require('node:fs');const {spawnSync}=require('node:child_process');
function call(c,a){const r=spawnSync(c,a,{stdio:'inherit'});if(r.status)process.exit(r.status);}
writeFileSync('sum.cjs','module.exports=(a,b)=>a+b;\\n');call('git',['add','sum.cjs']);call('git',['commit','-m','fix: implement sum']);call('wr-next',['done','--summary','Implemented sum with an exact commit']);`;
    const run = await launch(cfg, { work: first, cwd: checkout, argv: [process.execPath, "-e", program] });
    assert.equal(run.exitCode, 0);
    assert.equal(server.workspace.store.snapshot().work[first]!.state, "open", "submission waits for verification");
    const verification = await new Promise<number>((resolve, reject) => {
        const child = spawn(process.execPath, [resolveCli(), "verify", first, "--check", "tests", "--", process.execPath, "-e", "require('node:assert/strict').equal(require('./sum.cjs')(2,3),5)"], { cwd: checkout, env: process.env, stdio: "inherit" });
        child.on("error", reject);
        child.on("close", code => resolve(code ?? 1));
    });
    assert.equal(verification, 0);
    const sha = head(checkout)!, repo = repository(checkout), artifact = server.workspace.store.snapshot().artifacts[`${repo}@${sha}`];
    assert.ok(artifact?.context);
    assert.deepEqual(artifact.gaps, []);
    const reviewer = await launch(cfg, { work: second, cwd: checkout, role: "reviewer", readOnly: true, argv: [process.execPath, "-e", `require('node:assert/strict').equal(require('./sum.cjs')(4,6),10);const r=require('node:child_process').spawnSync('wr-next',['done','--summary','Independently checked exact HEAD'],{stdio:'inherit'});process.exitCode=r.status??1;`] });
    assert.equal(reviewer.exitCode, 0);
    const cap = await client.request<{
        token: string;
    }>("/v1/capabilities", { checks: ["github:*"] });
    await new Client({ ...cfg, token: cap.token }).command({ type: "github.sync", pullRequest: { repo, number: 1, url: "https://github.com/example/wr-next-proof/pull/1", title: "Synthetic PR snapshot (not a real GitHub PR)", author: "developer", head: sha, base: "main", state: "open", draft: true, commits: [sha], reviews: [], checks: [], updatedAt: "2026-09-01T00:00:00Z" } }, { observed: true });
    const v = await client.request<View>(`/v1/status?work=${root.id}`);
    assert.equal(v.items.find(w => w.id === root.id)!.state, "done");
    console.log(workpad(v));
    console.log(mermaid(v));
    const resultCount = Object.keys(server.workspace.store.snapshot().results).length;
    await client.command({ type: "migration.mode", source: source.id, mode: "legacy", confirm: root.key });
    assert.equal(server.workspace.store.snapshot().sources[source.id]!.mode, "legacy");
    assert.equal(Object.keys(server.workspace.store.snapshot().results).length, resultCount);
    uninstallHooks(checkout);
    console.log(JSON.stringify({ localProof: "passed", real: ["OS processes", "Git hooks and commit", "SQLite", "HTTP", "result verification", "scope authority rollback"], synthetic: ["agent", "GitHub PR snapshot", "legacy checklist"], productionCutover: "not performed" }, null, 2));
}
finally {
    await server.close();
    if (oldHome === undefined)
        delete process.env.WR_NEXT_HOME;
    else
        process.env.WR_NEXT_HOME = oldHome;
    if (oldContext === undefined)
        delete process.env.WR_NEXT_CONTEXT;
    else
        process.env.WR_NEXT_CONTEXT = oldContext;
    rmSync(directory, { recursive: true, force: true });
}
function resolveCli(): string { return resolve(new URL("../src/cli/main.js", import.meta.url).pathname); }
