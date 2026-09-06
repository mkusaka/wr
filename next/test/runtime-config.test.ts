import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, symlinkSync, linkSync, chmodSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { syncIntegrations, integrationStatus, requireInstalled, recoverIntegrations, readProjectConfig, projectRoot } from "../src/integrations/runtime-config/project.js";
import { groups, configPaths, configPath, ompExtension } from "../src/integrations/runtime-config/catalog.js";
import { gitPath } from "../src/git/repository.js";
function fixture() {
    const dir = mkdtempSync(join(tmpdir(), "wr-next-init-"));
    const g = spawnSync("git", ["init", "-q", dir]);
    assert.equal(g.status, 0);
    const write = (p: string, data: unknown) => { mkdirSync(join(dir, p, ".."), { recursive: true }); writeFileSync(join(dir, p), typeof data === "string" ? data : JSON.stringify(data), { mode: 0o644 }); };
    return { dir, write, close: () => rmSync(dir, { recursive: true, force: true }) };
}
const error = (code: string, fn: () => unknown) => assert.throws(fn, (e: any) => e.code === code);
const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));
test("dry-run leaves repo, Git-private state and authority untouched", () => {
    const f = fixture();
    try {
        const result = syncIntegrations(f.dir, { runtimes: ["claude", "codex", "omp", "devin"], dryRun: true });
        assert.ok(result.changed.length >= 5);
        assert.equal(existsSync(join(f.dir, ".wr")), false);
        assert.equal(existsSync(join(f.dir, ".claude")), false);
        assert.equal(existsSync(gitPath(f.dir, "wr-next")), false);
    }
    finally {
        f.close();
    }
});
test("static native projections preserve existing user settings and hooks", () => {
    const f = fixture();
    try {
        const original = { permissions: { deny: ["Bash(dangerous:*)"] }, env: { EXAMPLE: "value" }, hooks: { PreToolUse: [{ matcher: "Read", hooks: [{ type: "command", command: "user-hook" }] }] } };
        f.write(configPaths.claude, original);
        syncIntegrations(f.dir, { runtimes: ["claude", "codex", "omp", "devin"] });
        const settings = read(join(f.dir, configPaths.claude));
        assert.deepEqual(settings.permissions, original.permissions);
        assert.deepEqual(settings.env, original.env);
        assert.deepEqual(settings.hooks.PreToolUse[0], original.hooks.PreToolUse[0]);
        assert.equal(settings.hooks.PreToolUse.length, 2);
        assert.equal(existsSync(join(f.dir, ".codex/config.toml")), false);
        assert.ok(readFileSync(join(f.dir, configPaths.omp), "utf8").includes('pi.on("tool_call"'));
        assert.equal(existsSync(join(f.dir, ".devin")), false);
        for (const s of integrationStatus(f.dir))
            assert.equal(s.activation, "not-proven");
        assert.equal(integrationStatus(f.dir).find(x => x.runtime === "devin")!.installation, "wrapper-only");
    }
    finally {
        f.close();
    }
});
test("repeated init and sync do not change file bytes, mtimes or add duplicate hooks", () => {
    const f = fixture();
    try {
        syncIntegrations(f.dir, { runtimes: ["claude", "codex", "omp"] });
        const paths = [configPath, ...Object.values(configPaths)].map(p => join(f.dir, p));
        const before = paths.map(p => [readFileSync(p, "utf8"), statSync(p).mtimeMs]);
        assert.equal(syncIntegrations(f.dir, { runtimes: ["claude", "codex", "omp"] }).changed.length, 0);
        assert.deepEqual(paths.map(p => [readFileSync(p, "utf8"), statSync(p).mtimeMs]), before);
    }
    finally {
        f.close();
    }
});
test("uninstall retains unrelated settings, hooks added later and user handler siblings", () => {
    const f = fixture();
    try {
        f.write(configPaths.claude, { userField: { example: 1 } });
        syncIntegrations(f.dir, { runtimes: ["claude"] });
        const doc = read(join(f.dir, configPaths.claude));
        doc.hooks.PreToolUse[0].hooks.push({ type: "command", command: "user-later" });
        doc.hooks.SessionStart.push({ hooks: [{ type: "command", command: "another-user-hook" }] });
        f.write(configPaths.claude, doc);
        syncIntegrations(f.dir, { disable: ["claude"] });
        const remaining = read(join(f.dir, configPaths.claude));
        assert.deepEqual(remaining, { userField: { example: 1 }, hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "user-later" }] }], SessionStart: [{ hooks: [{ type: "command", command: "another-user-hook" }] }] } });
    }
    finally {
        f.close();
    }
});
test("uninstall removes only unchanged files originally created by this installer", () => {
    const f = fixture();
    try {
        syncIntegrations(f.dir, { runtimes: ["claude", "codex", "omp"] });
        syncIntegrations(f.dir, { disable: ["claude", "codex", "omp"] });
        for (const p of Object.values(configPaths))
            assert.equal(existsSync(join(f.dir, p)), false);
        assert.deepEqual(readProjectConfig(f.dir)!.integrations, { claude: false, codex: false, omp: false, devin: false });
    }
    finally {
        f.close();
    }
});
test("an exact shared projection can be adopted in a fresh clone and explicitly uninstalled", () => {
    const f = fixture();
    try {
        f.write(configPaths.claude, { hooks: Object.fromEntries(Object.entries(groups("claude")).map(([e, g]) => [e, [g]])), user: true });
        syncIntegrations(f.dir, { runtimes: ["claude"] });
        assert.equal(read(join(f.dir, configPaths.claude)).hooks.SessionStart.length, 1);
        rmSync(gitPath(f.dir, "wr-next/integrations"), { recursive: true });
        syncIntegrations(f.dir, { disable: ["claude"] });
        assert.deepEqual(read(join(f.dir, configPaths.claude)), { user: true });
    }
    finally {
        f.close();
    }
});
test("changed owned hook prevents sync and uninstall; no unrelated runtime is partially installed", () => {
    const f = fixture();
    try {
        syncIntegrations(f.dir, { runtimes: ["claude"] });
        const doc = read(join(f.dir, configPaths.claude));
        doc.hooks.SessionStart[0].hooks[0].command += " --edited";
        f.write(configPaths.claude, doc);
        const before = readFileSync(join(f.dir, configPath), "utf8");
        error("INTEGRATION_DRIFT", () => syncIntegrations(f.dir, { runtimes: ["codex"] }));
        error("INTEGRATION_DRIFT", () => syncIntegrations(f.dir, { disable: ["claude"] }));
        assert.equal(readFileSync(join(f.dir, configPath), "utf8"), before);
        assert.equal(existsSync(join(f.dir, configPaths.codex)), false);
        assert.equal(integrationStatus(f.dir)[0]!.installation, "drift");
    }
    finally {
        f.close();
    }
});
test("changing a managed hook matcher is a conflict rather than scope drift", () => {
    const f = fixture();
    try {
        syncIntegrations(f.dir, { runtimes: ["claude"] });
        const doc = read(join(f.dir, configPaths.claude));
        doc.hooks.PreToolUse[0].matcher = "Read";
        f.write(configPaths.claude, doc);
        error("INTEGRATION_DRIFT", () => syncIntegrations(f.dir));
    }
    finally {
        f.close();
    }
});
test("duplicate managed hooks are rejected instead of hiding duplicate observations", () => {
    const f = fixture();
    try {
        syncIntegrations(f.dir, { runtimes: ["claude"] });
        const doc = read(join(f.dir, configPaths.claude));
        doc.hooks.SessionStart.push(doc.hooks.SessionStart[0]);
        f.write(configPaths.claude, doc);
        error("INTEGRATION_DRIFT", () => syncIntegrations(f.dir));
    }
    finally {
        f.close();
    }
});
test("invalid JSON fails before any runtime/config file is written", () => {
    const f = fixture();
    try {
        f.write(configPaths.codex, "{not JSON}");
        error("INVALID_INTEGRATION_CONFIG", () => syncIntegrations(f.dir, { runtimes: ["claude", "codex"] }));
        assert.equal(existsSync(join(f.dir, configPaths.claude)), false);
        assert.equal(existsSync(join(f.dir, configPath)), false);
    }
    finally {
        f.close();
    }
});
test("a user's similarly named OMP extension is never overwritten", () => {
    const f = fixture();
    try {
        f.write(configPaths.omp, "export default function user() {}\n");
        error("INTEGRATION_CONFLICT", () => syncIntegrations(f.dir, { runtimes: ["omp"] }));
    }
    finally {
        f.close();
    }
});
test("inline Codex hooks and disabled hooks are not bypassed or rewritten", () => {
    const f = fixture();
    try {
        const inline = 'model = "example"\n[[hooks.SessionStart]]\nmatcher = "startup"\n';
        f.write(".codex/config.toml", inline);
        error("CODEX_INLINE_HOOKS", () => syncIntegrations(f.dir, { runtimes: ["codex"] }));
        assert.equal(readFileSync(join(f.dir, ".codex/config.toml"), "utf8"), inline);
        f.write(".codex/config.toml", "[features]\nhooks = false\n");
        error("INTEGRATION_DISABLED", () => syncIntegrations(f.dir, { runtimes: ["codex"] }));
        f.write(".codex/config.toml", 'model = "example"\n');
        syncIntegrations(f.dir, { runtimes: ["codex"] });
        assert.equal(readFileSync(join(f.dir, ".codex/config.toml"), "utf8"), 'model = "example"\n');
    }
    finally {
        f.close();
    }
});
test("Claude local override conflicts are reported before a managed launch", () => {
    const f = fixture();
    try {
        syncIntegrations(f.dir, { runtimes: ["claude"] });
        f.write(".claude/settings.local.json", { disableAllHooks: true });
        error("INTEGRATION_NOT_READY", () => requireInstalled(f.dir, "claude"));
    }
    finally {
        f.close();
    }
});
test("Git worktrees have independent static settings and installation manifests", () => {
    const f = fixture();
    const other = f.dir + "-linked";
    try {
        spawnSync("git", ["-C", f.dir, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "initial"]);
        assert.equal(spawnSync("git", ["-C", f.dir, "worktree", "add", "-q", "-b", "other", other]).status, 0);
        syncIntegrations(f.dir, { runtimes: ["claude"] });
        syncIntegrations(other, { runtimes: ["codex"] });
        assert.equal(readProjectConfig(f.dir)!.integrations.codex, false);
        assert.equal(readProjectConfig(other)!.integrations.claude, false);
        assert.notEqual(gitPath(f.dir, "wr-next/integrations"), gitPath(other, "wr-next/integrations"));
    }
    finally {
        rmSync(other, { recursive: true, force: true });
        f.close();
    }
});
test("OMP cwd-only discovery rejects subdirectory launch, Claude can start there", () => {
    const f = fixture();
    try {
        syncIntegrations(f.dir, { runtimes: ["claude", "omp"] });
        mkdirSync(join(f.dir, "src"));
        requireInstalled(join(f.dir, "src"), "claude");
        error("OMP_PROJECT_ROOT_REQUIRED", () => requireInstalled(join(f.dir, "src"), "omp"));
    }
    finally {
        f.close();
    }
});
test("OMP gitignored native module is not reported as ready", () => {
    const f = fixture();
    try {
        f.write(".gitignore", ".omp/\n");
        syncIntegrations(f.dir, { runtimes: ["omp"] });
        assert.equal(integrationStatus(f.dir).find(x => x.runtime === "omp")!.installation, "drift");
    }
    finally {
        f.close();
    }
});
for (const kind of ["file", "directory", "dangling", "hardlink", "writable"] as const)
    test(`unsafe ${kind} config is rejected`, () => {
        const f = fixture();
        const target = f.dir + "-outside";
        try {
            mkdirSync(join(f.dir, ".claude"));
            if (kind === "directory") {
                rmSync(join(f.dir, ".claude"), { recursive: true });
                mkdirSync(target);
                symlinkSync(target, join(f.dir, ".claude"));
            }
            else if (kind === "dangling")
                symlinkSync(target, join(f.dir, configPaths.claude));
            else {
                writeFileSync(target, "{}", { mode: 0o644 });
                if (kind === "file")
                    symlinkSync(target, join(f.dir, configPaths.claude));
                else if (kind === "hardlink")
                    linkSync(target, join(f.dir, configPaths.claude));
                else {
                    f.write(configPaths.claude, {});
                    chmodSync(join(f.dir, configPaths.claude), 0o666);
                }
            }
            error("UNSAFE_INTEGRATION_PATH", () => syncIntegrations(f.dir, { runtimes: ["claude"] }));
        }
        finally {
            f.close();
            rmSync(target, { recursive: true, force: true });
        }
    });
test("held installer lock never gets silently stolen", () => {
    const f = fixture();
    try {
        mkdirSync(gitPath(f.dir, "wr-next/integrations/lock"), { recursive: true });
        error("INTEGRATION_BUSY", () => syncIntegrations(f.dir, { runtimes: ["claude"] }));
    }
    finally {
        f.close();
    }
});
test("interrupted journal restores only planned files and preserves user settings", () => {
    const f = fixture();
    try {
        const root = projectRoot(f.dir), p = join(root, configPaths.claude), before = '{"user":1}\n', after = '{"user":1,"hooks":{}}\n';
        f.write(configPaths.claude, after);
        f.write(".git/wr-next/integrations/journal.json", { version: 1, root, changes: [{ path: p, before, after, mode: 0o644 }] });
        recoverIntegrations(f.dir);
        assert.equal(readFileSync(p, "utf8"), before);
        assert.equal(existsSync(gitPath(f.dir, "wr-next/integrations/journal.json")), false);
    }
    finally {
        f.close();
    }
});
test("recovery refuses a file edited after a crash", () => {
    const f = fixture();
    try {
        f.write(configPaths.claude, "{\"user\":2}\n");
        const root = projectRoot(f.dir), p = join(root, configPaths.claude);
        f.write(".git/wr-next/integrations/journal.json", { version: 1, root, changes: [{ path: p, before: "{}", after: '{"user":1}', mode: 0o644 }] });
        error("INTEGRATION_RECOVERY_CONFLICT", () => recoverIntegrations(f.dir));
        assert.equal(readFileSync(p, "utf8"), "{\"user\":2}\n");
    }
    finally {
        f.close();
    }
});
test("generated static files contain no dynamic binding or approval-bypass option", () => {
    const f = fixture();
    try {
        syncIntegrations(f.dir, { runtimes: ["claude", "codex", "omp"] });
        for (const p of [configPath, configPaths.claude, configPaths.codex])
            assert.doesNotMatch(readFileSync(join(f.dir, p), "utf8"), /execution_|work_|wn1\.|Bearer|bypass|permissionDecision/);
        assert.doesNotMatch(ompExtension(), /new_context|compaction\.enabled|disableAllHooks/);
    }
    finally {
        f.close();
    }
});
test("local Claude conflicts prevent partial installation across runtimes", () => {
    const f = fixture();
    try {
        f.write(".claude/settings.local.json", { disableAllHooks: true });
        error("INTEGRATION_DISABLED", () => syncIntegrations(f.dir, { runtimes: ["claude", "codex"] }));
        assert.equal(existsSync(join(f.dir, configPaths.claude)), false);
        assert.equal(existsSync(join(f.dir, configPaths.codex)), false);
        assert.equal(existsSync(join(f.dir, configPath)), false);
    }
    finally {
        f.close();
    }
});
