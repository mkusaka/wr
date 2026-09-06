import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, chmodSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { atomic, context, readJson, type ContextFile } from "../cli/files.js";
import { enqueue, syncOutbox } from "../cli/client.js";
import { git, gitPath, head, repository, readCommit, trailers, tryGit } from "./repository.js";
import { digest, demand, uid, now } from "../domain/util.js";
import type { CommitSnapshot } from "../domain/model.js";
const names = ["prepare-commit-msg", "commit-msg", "post-commit", "post-rewrite", "pre-push"];
const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
export const cliPath = (): string => fileURLToPath(new URL("../cli/main.js", import.meta.url));
type HookManifest = {
    files: {
        name: string;
        hash: string;
        backup: string | null;
    }[];
};
function hookDir(cwd: string): string {
    const configured = tryGit(cwd, ["config", "--get", "core.hooksPath"]);
    demand(!configured, "EXISTING_HOOKS_PATH", "core.hooksPath already configured; integrate 'wr-next internal git-hook NAME' manually. No config changed.");
    return gitPath(cwd, "hooks");
}
export function installHooks(cwd: string): unknown {
    const dir = hookDir(cwd);
    mkdirSync(dir, { recursive: true });
    const state = join(dir, "wr-next-install.json");
    if (existsSync(state))
        return hooksStatus(cwd);
    const manifest: HookManifest = { files: [] };
    for (const name of names) {
        const dest = join(dir, name), backup = existsSync(dest) ? `${dest}.wr-next-original` : null;
        demand(!backup || !existsSync(backup), "BACKUP_EXISTS", "Refusing to overwrite hook backup");
    }
    try {
        for (const name of names) {
            const dest = join(dir, name), backup = existsSync(dest) ? `${dest}.wr-next-original` : null;
            if (backup)
                renameSync(dest, backup);
            const reads = name === "post-rewrite" || name === "pre-push";
            const script = ["#!/bin/sh", "# wr-next managed hook v1", "status=0", ...(reads ? ["input=$(mktemp) || exit 1", "trap 'rm -f \"$input\"' EXIT HUP INT TERM", "cat > \"$input\""] : []), ...(backup ? [`if [ -x ${quote(backup)} ]; then ${quote(backup)} "$@"${reads ? ' < "$input"' : ""}; status=$?; fi`] : []), `${quote(process.execPath)} ${quote(cliPath())} internal git-hook ${name} "$@"${reads ? ' < "$input"' : ""} || :`, "exit \"$status\"", ""].join("\n");
            manifest.files.push({ name, hash: digest(script), backup });
            writeFileSync(dest, script, { mode: 0o755 });
            chmodSync(dest, 0o755);
        }
        atomic(state, manifest);
        return { installed: names };
    }
    catch (error) {
        for (const f of manifest.files) {
            const path = join(dir, f.name);
            if (existsSync(path))
                unlinkSync(path);
            if (f.backup && existsSync(f.backup))
                renameSync(f.backup, path);
        }
        throw error;
    }
}
export function hooksStatus(cwd: string): unknown {
    const dir = hookDir(cwd), path = join(dir, "wr-next-install.json");
    if (!existsSync(path))
        return { installed: false };
    return { files: readJson<HookManifest>(path).files.map(f => ({ name: f.name, intact: existsSync(join(dir, f.name)) && digest(readFileSync(join(dir, f.name), "utf8")) === f.hash })) };
}
export function uninstallHooks(cwd: string): unknown {
    const dir = hookDir(cwd), path = join(dir, "wr-next-install.json");
    if (!existsSync(path))
        return { removed: 0 };
    const record = readJson<HookManifest>(path);
    for (const f of record.files)
        demand(existsSync(join(dir, f.name)) && digest(readFileSync(join(dir, f.name), "utf8")) === f.hash, "HOOK_MODIFIED", "Managed hook was edited; restore manually");
    for (const f of record.files) {
        unlinkSync(join(dir, f.name));
        if (f.backup)
            renameSync(f.backup, join(dir, f.name));
    }
    unlinkSync(path);
    return { removed: record.files.length };
}
type PendingContributor = {
    execution: string;
    identity: string | null;
};
function contributorPath(cwd: string, ctx: ContextFile): string { return gitPath(cwd, `wr-next/contributors/${ctx.execution}.json`); }
export function contribute(cwd: string, execution: string, identity?: string): void {
    const ctx = context();
    demand(ctx, "AMBIGUOUS_CONTEXT", "Use contribute inside a managed run");
    if (identity)
        demand(/^[^<>\r\n]+ <[^<>\s\r\n]+@[^<>\s\r\n]+>$/.test(identity), "INVALID_IDENTITY", "Use Name <email>");
    const file = contributorPath(cwd, ctx), entries = existsSync(file) ? readJson<PendingContributor[]>(file) : [];
    if (!entries.some(e => e.execution === execution))
        entries.push({ execution, identity: identity ?? null });
    atomic(file, entries);
}
function queue(ctx: ContextFile, command: unknown): void { enqueue({ ...ctx, token: ctx.gitToken }, "/v1/observations", { schemaVersion: 1, operationId: uid("gitop"), command }); }
export function prepare(cwd: string, file: string): void {
    const ctx = context();
    if (!ctx)
        return;
    demand(git(cwd, ["rev-parse", "--path-format=absolute", "--git-dir"]) === ctx.environment, "CONTEXT_ENVIRONMENT_MISMATCH", "Commit context belongs to another worktree");
    const msg = readFileSync(file, "utf8");
    const parsed = trailers(cwd, msg);
    const contributors = existsSync(contributorPath(cwd, ctx)) ? readJson<PendingContributor[]>(contributorPath(cwd, ctx)) : [];
    const snapshot: CommitSnapshot = { id: uid("context"), work: ctx.work, execution: ctx.execution, scopeRevision: ctx.scopeRevision, generation: ctx.generation, repo: repository(cwd), tree: git(cwd, ["write-tree"]), base: head(cwd), branch: tryGit(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]), capturedAt: now(), contributors: [...new Set([...ctx.contributors, ...contributors.map(c => c.execution)])] };
    const source = tryGit(cwd, ["rev-parse", "--verify", "CHERRY_PICK_HEAD"]);
    if (source)
        snapshot.originCommit = source;
    // Record before touching the message. Aborted commits leave recoverable, unconsumed state.
    atomic(gitPath(cwd, `wr-next/contexts/${snapshot.id}.json`), { snapshot, digest: digest(snapshot), contributors });
    const args = ["-c", "trailer.separators=:", "interpret-trailers", "--in-place", "--if-exists=replace", "--if-missing=add", "--trailer", `WR-Work: ${ctx.work}`, "--trailer", `WR-Context: ${snapshot.id}`];
    // Co-authors require explicit contribution and identity; never infer from committer.
    const author = tryGit(cwd, ["var", "GIT_AUTHOR_IDENT"])?.replace(/>.*$/, ">");
    for (const c of contributors)
        if (c.identity && c.identity !== author && !(parsed.get("co-authored-by") ?? []).includes(c.identity))
            args.push("--if-exists=addIfDifferent", "--trailer", `Co-authored-by: ${c.identity}`);
    git(cwd, [...args, file]);
}
export function finalize(cwd: string): void {
    const ctx = context();
    if (!ctx)
        return;
    demand(git(cwd, ["rev-parse", "--path-format=absolute", "--git-dir"]) === ctx.environment, "CONTEXT_ENVIRONMENT_MISMATCH", "Commit observation belongs to another worktree");
    const { message, ...commit } = readCommit(cwd), ids = trailers(cwd, message).get("wr-context") ?? [];
    const record = ids.length === 1 && /^context_[a-f0-9-]{36}$/.test(ids[0]!) && existsSync(gitPath(cwd, `wr-next/contexts/${ids[0]}.json`)) ? readJson<{
        snapshot: CommitSnapshot;
        digest: string;
    }>(gitPath(cwd, `wr-next/contexts/${ids[0]}.json`)) : null;
    // Copied trailers in rebases are not evidence that the current run authored old code.
    const own = record?.snapshot.execution === ctx.execution;
    queue(ctx, { type: "git.commit", commit, snapshot: own ? record!.snapshot : null, snapshotDigest: own ? record!.digest : null });
    if (own && record!.snapshot.originCommit)
        queue(ctx, { type: "git.rewrite", repo: commit.repo, operation: "cherry-pick", pairs: [{ old: record!.snapshot.originCommit, new: commit.sha }] });
    if (own && existsSync(contributorPath(cwd, ctx)))
        unlinkSync(contributorPath(cwd, ctx));
}
export function rewritten(cwd: string, operation: string, input: string): void {
    const ctx = context();
    if (!ctx)
        return;
    demand(git(cwd, ["rev-parse", "--path-format=absolute", "--git-dir"]) === ctx.environment, "CONTEXT_ENVIRONMENT_MISMATCH", "Rewrite belongs to another worktree");
    demand(["amend", "rebase"].includes(operation), "INVALID_REWRITE", "Unknown rewrite operation");
    const pairs = input.trim().split("\n").filter(Boolean).map(line => { const [old, next] = line.split(/\s+/); demand(old && next, "INVALID_REWRITE", "Expected old/new mapping"); return { old, new: next }; });
    queue(ctx, { type: "git.rewrite", repo: repository(cwd), operation, pairs });
}
export function checkRange(cwd: string, range: string): unknown {
    const shas = git(cwd, ["rev-list", range]).split("\n").filter(Boolean);
    return { commits: shas.map(sha => { const c = readCommit(cwd, sha), ts = trailers(cwd, c.message); return { sha, tracked: (ts.get("wr-context") ?? []).length === 1, work: ts.get("wr-work") ?? [] }; }) };
}
export async function gitHook(cwd: string, name: string, args: string[], input = ""): Promise<void> {
    if (name === "prepare-commit-msg") {
        demand(args[0], "INVALID_INPUT", "Message path required");
        prepare(cwd, args[0]);
    }
    else if (name === "commit-msg") {
        const file = args[0];
        demand(file, "INVALID_INPUT", "Message path required");
        const ts = trailers(cwd, readFileSync(file, "utf8"));
        for (const key of ["wr-work", "wr-context"])
            demand((ts.get(key) ?? []).length <= 1, "DUPLICATE_TRAILER", `Duplicate ${key}`);
    }
    else if (name === "post-commit")
        finalize(cwd);
    else if (name === "post-rewrite")
        rewritten(cwd, args[0] ?? "", input);
    else if (name === "pre-push") {
        // Do not enumerate an unbounded history for a new remote ref. Sync observations first.
        const result = await syncOutbox();
        if (result.pending || result.conflicts.length)
            console.error(`wr-next: pending=${result.pending}, conflicts=${result.conflicts.length}`);
    }
}
