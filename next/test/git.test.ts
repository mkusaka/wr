import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { startLocal } from "../src/server/local.js";
import { Client, syncOutbox } from "../src/cli/client.js";
import { atomic, type ContextFile } from "../src/cli/files.js";
import { git, gitPath, readCommit, trailers, head } from "../src/git/repository.js";
import { installHooks, uninstallHooks, contribute } from "../src/git/hooks.js";
async function setup() {
    const dir = mkdtempSync(join(tmpdir(), "wr-next-git-")), repo = join(dir, "repo");
    mkdirSync(repo);
    const prev = { home: process.env.WR_NEXT_HOME, context: process.env.WR_NEXT_CONTEXT };
    process.env.WR_NEXT_HOME = join(dir, "state");
    git(repo, ["init", "--initial-branch=main"]);
    git(repo, ["config", "user.name", "Test Human"]);
    git(repo, ["config", "user.email", "test@example.invalid"]);
    git(repo, ["config", "wr-next.repositoryId", "local:fixture"]);
    writeFileSync(join(repo, "base"), "base");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "baseline"]);
    const base = head(repo)!;
    const server = await startLocal({ database: ":memory:" }), cfg = { server: server.url, workspace: "local", device: "git-device", token: server.secret }, client = new Client(cfg);
    const w = await client.command({ type: "work.create", title: "code", policy: { name: "evidence-v1", checks: ["test"] } });
    const result = await client.command({ type: "execution.start", work: w.result.id, environment: git(repo, ["rev-parse", "--path-format=absolute", "--git-dir"]), launchId: "git-test" });
    const ctx: ContextFile = { ...cfg, ...result.result, token: result.capabilities.worker, gitToken: result.capabilities.git, contributors: [] };
    const contextPath = join(dir, "context.json");
    atomic(contextPath, ctx);
    process.env.WR_NEXT_CONTEXT = contextPath;
    return { dir, repo, base, server, client, ctx, w, contextPath, write: (name: string, value: string) => writeFileSync(join(repo, name), value), commit: (message: string) => { git(repo, ["add", "."]); git(repo, ["commit", "-m", message]); return head(repo)!; }, cleanup: async () => {
            await server.close();
            if (prev.home === undefined)
                delete process.env.WR_NEXT_HOME;
            else
                process.env.WR_NEXT_HOME = prev.home;
            if (prev.context === undefined)
                delete process.env.WR_NEXT_CONTEXT;
            else
                process.env.WR_NEXT_CONTEXT = prev.context;
            rmSync(dir, { recursive: true, force: true });
        } };
}
test("real Git hooks preserve identity and bind the actual committed tree", async () => {
    const f = await setup();
    try {
        installHooks(f.repo);
        f.write("a", "hello");
        const sha = f.commit("change");
        const commit = readCommit(f.repo);
        assert.equal(commit.author, "Test Human <test@example.invalid>");
        assert.equal(trailers(f.repo, commit.message).get("wr-work")![0], f.ctx.work);
        assert.equal(trailers(f.repo, commit.message).get("co-authored-by"), undefined);
        const synced = await syncOutbox();
        assert.equal(synced.conflicts.length, 0);
        const state = f.server.workspace.store.snapshot(), artifact = state.artifacts[`local:fixture@${sha}`]!;
        assert.deepEqual(artifact.gaps, []);
        assert.equal(state.contexts[artifact.context!]!.snapshot.tree, commit.tree);
    }
    finally {
        await f.cleanup();
    }
});
test("partial commit uses Git's effective temporary index", async () => {
    const f = await setup();
    try {
        installHooks(f.repo);
        f.write("a", "one");
        f.write("b", "two");
        git(f.repo, ["add", "a", "b"]);
        git(f.repo, ["commit", "a", "-m", "only a"]);
        const sha = head(f.repo)!;
        assert.match(git(f.repo, ["status", "--porcelain"]), /A  b/);
        await syncOutbox();
        const state = f.server.workspace.store.snapshot(), a = state.artifacts[`local:fixture@${sha}`]!;
        assert.deepEqual(a.gaps, []);
        assert.equal(state.contexts[a.context!]!.snapshot.tree, readCommit(f.repo).tree);
    }
    finally {
        await f.cleanup();
    }
});
test("explicit co-author is added once; commit execution is not inferred implementation", async () => {
    const f = await setup();
    try {
        installHooks(f.repo);
        contribute(f.repo, f.ctx.execution, "Contributor <co@example.invalid>");
        contribute(f.repo, f.ctx.execution, "Contributor <co@example.invalid>");
        f.write("a", "one");
        const sha = f.commit("with author");
        const ts = trailers(f.repo, readCommit(f.repo).message);
        assert.deepEqual(ts.get("co-authored-by"), ["Contributor <co@example.invalid>"]);
        await syncOutbox();
        const rows = Object.values(f.server.workspace.store.snapshot().contributions).filter(c => c.artifact === `local:fixture@${sha}`);
        assert.equal(rows.filter(c => c.relation === "implemented_by").length, 1);
        assert.equal(rows.find(c => c.relation === "implemented_by")!.source, "declared");
    }
    finally {
        await f.cleanup();
    }
});
test("existing failing commit hook is preserved and contributor is not consumed on abort", async () => {
    const f = await setup();
    try {
        const path = gitPath(f.repo, "hooks/commit-msg");
        writeFileSync(path, "#!/bin/sh\nexit 7\n", { mode: 0o755 });
        installHooks(f.repo);
        contribute(f.repo, f.ctx.execution);
        f.write("a", "one");
        git(f.repo, ["add", "."]);
        const p = spawnSync("git", ["-C", f.repo, "commit", "-m", "fail"], { encoding: "utf8" });
        assert.notEqual(p.status, 0);
        assert.equal(head(f.repo), f.base);
        assert.ok(existsSync(gitPath(f.repo, `wr-next/contributors/${f.ctx.execution}.json`)));
        uninstallHooks(f.repo);
        assert.equal(readFileSync(path, "utf8"), "#!/bin/sh\nexit 7\n");
    }
    finally {
        await f.cleanup();
    }
});
test("amend stores old/new lineage without deleting original contribution", async () => {
    const f = await setup();
    try {
        installHooks(f.repo);
        contribute(f.repo, f.ctx.execution);
        f.write("a", "one");
        const old = f.commit("one");
        f.write("a", "two");
        git(f.repo, ["add", "a"]);
        git(f.repo, ["commit", "--amend", "-m", "two"]);
        const next = head(f.repo)!;
        const sync = await syncOutbox();
        assert.deepEqual(sync.conflicts, []);
        const state = f.server.workspace.store.snapshot();
        assert.ok(Object.values(state.rewrites).some(r => r.old === old && r.new === next && r.operation === "amend"));
        assert.ok(Object.values(state.contributions).some(c => c.artifact === `local:fixture@${old}` && c.relation === "implemented_by"));
        assert.ok(Object.values(state.contributions).some(c => c.artifact === `local:fixture@${next}` && c.relation === "amended_by"));
    }
    finally {
        await f.cleanup();
    }
});
test("actual rebase captures a mapping and preserves contributors", async () => {
    const f = await setup();
    try {
        installHooks(f.repo);
        git(f.repo, ["switch", "-c", "topic"]);
        contribute(f.repo, f.ctx.execution);
        f.write("feature", "one");
        const old = f.commit("feature");
        git(f.repo, ["switch", "main"]);
        f.write("main-only", "base moved");
        f.commit("main moves");
        git(f.repo, ["switch", "topic"]);
        git(f.repo, ["rebase", "main"]);
        const next = head(f.repo)!;
        assert.notEqual(old, next);
        const sync = await syncOutbox();
        assert.deepEqual(sync.conflicts, []);
        const state = f.server.workspace.store.snapshot();
        assert.ok(Object.values(state.rewrites).some(r => r.old === old && r.new === next && r.operation === "rebase"));
        assert.ok(Object.values(state.contributions).some(c => c.artifact === `local:fixture@${next}` && c.relation === "implemented_by"));
    }
    finally {
        await f.cleanup();
    }
});
test("actual autosquash keeps many-to-one rewrite mappings", async () => {
    const f = await setup();
    const prev = process.env.GIT_SEQUENCE_EDITOR;
    try {
        installHooks(f.repo);
        f.write("feature", "one");
        const one = f.commit("feature");
        f.write("feature", "two");
        const two = f.commit("fixup! feature");
        process.env.GIT_SEQUENCE_EDITOR = "true";
        git(f.repo, ["rebase", "-i", "--autosquash", f.base]);
        const next = head(f.repo)!;
        await syncOutbox();
        const rewrites = Object.values(f.server.workspace.store.snapshot().rewrites);
        assert.ok(rewrites.some(r => r.old === one && r.new === next));
        assert.ok(rewrites.some(r => r.old === two && r.new === next));
    }
    finally {
        if (prev === undefined)
            delete process.env.GIT_SEQUENCE_EDITOR;
        else
            process.env.GIT_SEQUENCE_EDITOR = prev;
        await f.cleanup();
    }
});
test("cherry-pick records source when Git exposes CHERRY_PICK_HEAD", async () => {
    const f = await setup();
    try {
        installHooks(f.repo);
        git(f.repo, ["switch", "-c", "source"]);
        contribute(f.repo, f.ctx.execution);
        f.write("feature", "one");
        const old = f.commit("feature");
        git(f.repo, ["switch", "main"]);
        f.write("main-only", "two");
        f.commit("base moves");
        git(f.repo, ["cherry-pick", "-x", old]);
        const next = head(f.repo)!;
        const sync = await syncOutbox();
        assert.deepEqual(sync.conflicts, []);
        assert.ok(Object.values(f.server.workspace.store.snapshot().rewrites).some(r => r.old === old && r.new === next && r.operation === "cherry-pick"));
    }
    finally {
        await f.cleanup();
    }
});
test("custom hooksPath and locally edited wrappers are never overwritten", async () => {
    const f = await setup();
    try {
        git(f.repo, ["config", "core.hooksPath", ".husky"]);
        assert.throws(() => installHooks(f.repo), /core.hooksPath/);
        git(f.repo, ["config", "--unset", "core.hooksPath"]);
        installHooks(f.repo);
        const path = gitPath(f.repo, "hooks/post-commit");
        writeFileSync(path, readFileSync(path, "utf8") + "# edited\n");
        assert.throws(() => uninstallHooks(f.repo), /edited/);
        assert.ok(existsSync(path));
    }
    finally {
        await f.cleanup();
    }
});
test("post-rewrite wrapper gives the original hook the complete same stdin", async () => {
    const f = await setup();
    try {
        const output = join(f.dir, "stdin.txt"), hook = gitPath(f.repo, "hooks/post-rewrite");
        writeFileSync(hook, `#!/bin/sh\ncat > '${output}'\nexit 6\n`, { mode: 0o755 });
        installHooks(f.repo);
        const content = `${"a".repeat(40)} ${"b".repeat(40)}\n`;
        const p = spawnSync(hook, ["rebase"], { cwd: f.repo, env: process.env, input: content, encoding: "utf8" });
        assert.equal(p.status, 6);
        assert.equal(readFileSync(output, "utf8"), content);
    }
    finally {
        await f.cleanup();
    }
});
