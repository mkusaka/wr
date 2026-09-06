import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectPr, createPr } from "../src/integrations/github.js";
import { git } from "../src/git/repository.js";
import { startLocal } from "../src/server/local.js";
import { Client } from "../src/cli/client.js";
const A = "a".repeat(40), B = "b".repeat(40);
function fakeGh(options: {
    moving?: boolean;
    createError?: boolean;
} = {}) {
    const directory = mkdtempSync(join(tmpdir(), "wr-next-gh-")), oldPath = process.env.PATH, oldHome = process.env.WR_NEXT_HOME;
    process.env.WR_NEXT_HOME = join(directory, "state");
    process.env.PATH = `${directory}:${oldPath ?? ""}`;
    const config = join(directory, "fixture.json");
    writeFileSync(config, JSON.stringify({ calls: [], creates: 0, reads: 0, created: false, ...options }));
    const executable = join(directory, "gh");
    writeFileSync(executable, `#!/usr/bin/env bun
const fs=require('node:fs'),path=${JSON.stringify(config)},s=JSON.parse(fs.readFileSync(path,'utf8')),args=process.argv.slice(2);
s.calls.push(args);let output;
if(args[0]==='api'){
 const endpoint=args.at(-1);
 if(endpoint.endsWith('/pulls/1')){s.reads++;output={html_url:'https://github.com/example/synthetic/pull/1',title:'test',user:{login:'owner'},head:{sha:s.moving&&s.reads%2===0?'${B}':'${A}'},base:{ref:'main'},merged_at:null,state:'open',draft:true,updated_at:'2026-09-01T00:00:00Z'};}
 else if(endpoint.endsWith('/commits'))output=[[{sha:'${A}'}]];
 else if(endpoint.endsWith('/reviews'))output=[[{id:1,user:{login:'reviewer'},commit_id:'${A}',state:'APPROVED'}]];
 else if(endpoint.endsWith('/check-runs'))output=[{check_runs:[{id:1,name:'tests',head_sha:'${A}',status:'completed',conclusion:'failure'},{id:2,name:'tests',head_sha:'${A}',status:'completed',conclusion:'success'}]}];
 else if(endpoint.endsWith('/statuses'))output=[[]];
 else throw new Error('Unhandled endpoint '+endpoint);
}else if(args[0]==='pr'&&args[1]==='create'){
 s.creates++;s.created=true;s.body=fs.readFileSync(args[args.indexOf('--body-file')+1],'utf8');output='https://github.com/example/synthetic/pull/1';
}else if(args[0]==='pr'&&args[1]==='list')output=s.created?[{number:1,url:'https://github.com/example/synthetic/pull/1',body:s.body}]:[];
else throw new Error('Unexpected gh arguments');
fs.writeFileSync(path,JSON.stringify(s));
if(s.createError&&args[0]==='pr'&&args[1]==='create'){process.stderr.write('simulated response loss after creation');process.exit(1);}
process.stdout.write(typeof output==='string'?output:JSON.stringify(output));
`, { mode: 0o700 });
    return { directory, fixture: () => JSON.parse(readFileSync(config, "utf8")), close: () => {
            if (oldPath === undefined)
                delete process.env.PATH;
            else
                process.env.PATH = oldPath;
            if (oldHome === undefined)
                delete process.env.WR_NEXT_HOME;
            else
                process.env.WR_NEXT_HOME = oldHome;
            rmSync(directory, { recursive: true, force: true });
        } };
}
test("GitHub CLI collector paginates and reads HEAD again before accepting snapshot", () => {
    const f = fakeGh();
    try {
        const result = collectPr("example/synthetic", 1);
        assert.equal(result.head, A);
        assert.deepEqual(result.commits, [A]);
        assert.deepEqual(result.checks, [{ name: "tests", sha: A, status: "passed" }]);
        assert.equal(f.fixture().reads, 2);
        assert.ok(f.fixture().calls.some((args: string[]) => args.includes("--paginate")));
    }
    finally {
        f.close();
    }
});
test("collector refuses a PR that changed during pagination", () => {
    const f = fakeGh({ moving: true });
    try {
        assert.throws(() => collectPr("example/synthetic", 1), (e: any) => e.code === "PR_CHANGED_DURING_SYNC");
    }
    finally {
        f.close();
    }
});
test("ambiguous PR creation reconciles receipt instead of creating twice", async () => {
    const f = fakeGh({ createError: true }), server = await startLocal({ database: join(f.directory, "db.sqlite") });
    try {
        const cfg = { server: server.url, workspace: "local", device: "gh-test", token: server.secret }, client = new Client(cfg);
        const w = await client.command({ type: "work.create", title: "synthetic" });
        const cwd = join(f.directory, "repo");
        mkdirSync(cwd);
        git(cwd, ["init", "-b", "main"]);
        git(cwd, ["remote", "add", "origin", "https://github.com/example/synthetic.git"]);
        const options = { work: w.result.id, title: "change", body: "summary", base: "main", cwd, effectId: "create-once" };
        await assert.rejects(createPr(cfg, options), (e: any) => e.code === "GITHUB_ERROR");
        assert.equal(f.fixture().creates, 1);
        const out = await createPr(cfg, options);
        assert.ok(out);
        assert.equal(f.fixture().creates, 1);
        assert.equal(server.workspace.store.snapshot().effects["create-once"]!.state, "succeeded");
        // Lost local receipts do not authorize a second external action.
        rmSync(join(process.env.WR_NEXT_HOME!, "effects"), { recursive: true, force: true });
        await createPr(cfg, options);
        assert.equal(f.fixture().creates, 1);
    }
    finally {
        await server.close();
        f.close();
    }
});
test("authority-side external effect claim permits only one creator", async () => {
    const f = fakeGh(), server = await startLocal({ database: join(f.directory, "db.sqlite") });
    try {
        const client = new Client({ server: server.url, workspace: "local", device: "gh-test", token: server.secret });
        const w = await client.command({ type: "work.create", title: "w" });
        await client.command({ type: "effect.prepare", work: w.result.id, effectId: "effect", kind: "pr.create", payload: { repo: "github.com/example/synthetic", head: "main", base: "other", title: "change", body: "" } });
        const attempts = await Promise.allSettled([1, 2].map(() => client.command({ type: "effect.begin", effectId: "effect" })));
        assert.equal(attempts.filter(a => a.status === "fulfilled").length, 1);
    }
    finally {
        await server.close();
        f.close();
    }
});
test("operation IDs cannot traverse local receipt paths", async () => {
    const f = fakeGh(), server = await startLocal({ database: join(f.directory, "db.sqlite") });
    try {
        const cfg = { server: server.url, workspace: "local", device: "gh-test", token: server.secret };
        const cwd = join(f.directory, "repo");
        mkdirSync(cwd);
        git(cwd, ["init", "-b", "main"]);
        git(cwd, ["remote", "add", "origin", "https://github.com/example/synthetic.git"]);
        await assert.rejects(createPr(cfg, { work: "W1", title: "change", body: "", base: "main", cwd, effectId: "../../escape" }), (e: any) => e.code === "INVALID_EFFECT_ID");
        assert.equal(f.fixture().creates, 0);
    }
    finally {
        await server.close();
        f.close();
    }
});
