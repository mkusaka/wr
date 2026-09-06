import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { Fault, demand } from "../domain/util.js";
export function git(cwd: string, args: string[], input?: string): string {
    const p = spawnSync("git", ["-C", cwd, ...args], { input, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, env: process.env });
    if (p.error || p.status !== 0)
        throw new Fault("GIT_ERROR", p.stderr?.trim() || p.error?.message || "Git command failed", 400);
    return p.stdout.trimEnd();
}
export function tryGit(cwd: string, args: string[]): string | null {
    try {
        return git(cwd, args);
    }
    catch {
        return null;
    }
}
export const gitPath = (cwd: string, path: string): string => resolve(cwd, git(cwd, ["rev-parse", "--path-format=absolute", "--git-path", path]));
export const root = (cwd: string): string => realpathSync(git(cwd, ["rev-parse", "--show-toplevel"]));
export const head = (cwd: string): string | null => tryGit(cwd, ["rev-parse", "--verify", "HEAD"]);
export function repository(cwd: string): string {
    const remote = tryGit(cwd, ["config", "--get", "remote.origin.url"]);
    if (remote) {
        const match = remote.match(/^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/);
        if (match)
            return `github.com/${match[1]}`;
    }
    // A stable local identity avoids guessing GitHub ownership from paths.
    const configured = tryGit(cwd, ["config", "--get", "wr-next.repositoryId"]);
    demand(configured, "REPOSITORY_UNKNOWN", "No supported origin. Set git config wr-next.repositoryId local:<stable-id>");
    return configured;
}
export function readCommit(cwd: string, revision = "HEAD") {
    const resolved = git(cwd, ["rev-parse", "--verify", `${revision}^{commit}`]);
    const fields = git(cwd, ["show", "-s", "--format=%H%x00%T%x00%P%x00%s%x00%an <%ae>%x00%cn <%ce>%x00%B", resolved]).split("\0");
    return { repo: repository(cwd), sha: fields[0]!, tree: fields[1]!, parents: fields[2] ? fields[2].split(" ") : [], subject: fields[3]!, author: fields[4]!, committer: fields[5]!, message: fields.slice(6).join("\0") };
}
export function trailers(cwd: string, message: string): Map<string, string[]> {
    const parsed = git(cwd, ["-c", "trailer.separators=:", "interpret-trailers", "--parse"], message);
    const out = new Map<string, string[]>();
    for (const line of parsed.split("\n")) {
        const split = line.indexOf(":");
        if (split < 0)
            continue;
        const key = line.slice(0, split).toLowerCase(), value = line.slice(split + 1).trim();
        out.set(key, [...(out.get(key) ?? []), value]);
    }
    return out;
}
