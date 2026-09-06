import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { Client } from "../cli/client.js";
import { atomic, readJson, stateHome, context, type Connection } from "../cli/files.js";
import { demand, digest, Fault } from "../domain/util.js";
import { git, repository } from "../git/repository.js";
export function gh(args: string[], cwd = process.cwd()): string {
    const p = spawnSync("gh", args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: "1" } });
    if (p.error || p.status !== 0)
        throw new Fault("GITHUB_ERROR", p.stderr?.trim() || p.error?.message || "GitHub CLI failed", 502);
    return p.stdout.trim();
}
const pages = (path: string): any[] => JSON.parse(gh(["api", "--paginate", "--slurp", path]));
export function collectPr(repo: string, number: number): Record<string, unknown> {
    repo = repo.replace(/^github.com\//, "");
    demand(/^[\w.-]+\/[\w.-]+$/.test(repo) && Number.isSafeInteger(number) && number > 0, "INVALID_PR", "Use owner/repo and a positive PR number", 400);
    const pr = JSON.parse(gh(["api", `repos/${repo}/pulls/${number}`]));
    const commits = pages(`repos/${repo}/pulls/${number}/commits`).flat().map(c => c.sha);
    const reviews = pages(`repos/${repo}/pulls/${number}/reviews`).flat().sort((a, b) => a.id - b.id).filter(r => r.commit_id).map(r => ({ id: String(r.id), author: r.user?.login ?? "unknown", sha: r.commit_id, state: r.state }));
    const rawChecks = pages(`repos/${repo}/commits/${pr.head.sha}/check-runs`).flatMap(p => p.check_runs);
    const checks = new Map<string, {
        name: string;
        sha: string;
        status: string;
    }>();
    for (const c of rawChecks.sort((a, b) => a.id - b.id))
        checks.set(c.name, { name: c.name, sha: c.head_sha, status: c.status !== "completed" ? "pending" : c.conclusion === "success" ? "passed" : "failed" });
    const statuses = pages(`repos/${repo}/commits/${pr.head.sha}/statuses`).flat().sort((a, b) => a.id - b.id);
    for (const c of statuses)
        checks.set(c.context, { name: c.context, sha: pr.head.sha, status: c.state === "success" ? "passed" : c.state === "pending" ? "pending" : "failed" });
    const current = JSON.parse(gh(["api", `repos/${repo}/pulls/${number}`]));
    demand(current.head.sha === pr.head.sha && current.updated_at === pr.updated_at, "PR_CHANGED_DURING_SYNC", "PR changed while collecting; retry the read-only synchronization");
    return { repo: `github.com/${repo}`, number, url: pr.html_url, title: pr.title, author: pr.user?.login ?? null, head: pr.head.sha, base: pr.base.ref, state: pr.merged_at ? "merged" : pr.state, draft: Boolean(pr.draft), commits, reviews, checks: [...checks.values()], updatedAt: pr.updated_at };
}
async function githubClient(cfg: Connection): Promise<Client> {
    const ctx = "githubToken" in cfg ? cfg as import("../cli/files.js").ContextFile : context();
    if (ctx?.githubToken)
        return new Client({ ...cfg, token: ctx.githubToken });
    const response = await new Client(cfg).request<{
        token: string;
    }>("/v1/capabilities", { checks: ["github:*"] });
    return new Client({ ...cfg, ...(!cfg.accessToken && !cfg.token.startsWith("wn1.") && cfg.token.split(".").length === 3 ? { accessToken: cfg.token } : {}), token: response.token });
}
export async function syncPr(cfg: Connection, repo: string, number: number, effectId?: string): Promise<unknown> {
    const pr = collectPr(repo, number);
    return (await githubClient(cfg)).command({ type: "github.sync", pullRequest: pr, effectId }, { observed: true, queue: true });
}
/** Side effects have durable local receipts. Ambiguous creation is reconciled, never blindly retried. */
export async function createPr(cfg: Connection, options: {
    work?: string;
    title: string;
    body: string;
    base: string;
    cwd?: string;
    effectId?: string;
}): Promise<unknown> {
    const cwd = options.cwd ?? process.cwd(), repo = repository(cwd), name = repo.replace(/^github.com\//, "");
    demand(repo.startsWith("github.com/"), "NOT_GITHUB", "GitHub origin required");
    const branch = git(cwd, ["branch", "--show-current"]);
    demand(branch, "DETACHED_HEAD", "PR requires a branch");
    const ctx = context(), work = options.work ?? ctx?.work;
    demand(work, "AMBIGUOUS_CONTEXT", "Select work for this PR");
    const effectId = options.effectId ?? digest({ repo, branch, work }).replace(":", "_");
    demand(/^[A-Za-z0-9_-]{1,128}$/.test(effectId), "INVALID_EFFECT_ID", "Operation ID must be a safe identifier", 400);
    const marker = `<!-- wr-next:operation:${effectId} -->`, receiptPath = join(stateHome(), "effects", `${effectId}.json`);
    const payload = { repo, head: branch, base: options.base, title: options.title, body: `${options.body}\n\n${marker}` };
    const client = new Client(cfg);
    const toolSuffix = ctx?.dispatch ? `-${digest(ctx.dispatch).slice(0, 16)}` : "";
    await client.command({ type: "effect.prepare", effectId, work, kind: "pr.create", payload }, { id: `prepare-${effectId}${toolSuffix}` });
    const effectToken = ctx?.effectToken ?? ctx?.launcherToken;
    const resolver = effectToken ? new Client({ ...cfg, token: effectToken }) : client;
    const stored = await client.request<{
        state: string;
        result: string | null;
    }>(`/v1/effect?id=${encodeURIComponent(effectId)}`);
    let receipt = { state: stored.state, url: stored.result };
    const local = existsSync(receiptPath) ? readJson<{
        state: string;
        url: string | null;
    }>(receiptPath) : null;
    if (local?.state === "succeeded" && receipt.state === "unknown")
        receipt = local;
    if (receipt.state === "unknown") {
        const prs = JSON.parse(gh(["pr", "list", "--repo", name, "--head", branch, "--state", "all", "--limit", "100", "--json", "number,url,body"], cwd)) as {
            number: number;
            url: string;
            body: string;
        }[];
        const matches = prs.filter(p => p.body.includes(marker));
        demand(matches.length === 1, "EXTERNAL_EFFECT_UNKNOWN", "PR creation may have occurred. Reconcile before retrying; no duplicate PR created");
        receipt = { state: "succeeded", url: matches[0]!.url };
    }
    if (receipt.state === "prepared") {
        // Atomic authority-side claim prevents two launchers, or lost local receipts, from duplicating a PR.
        await resolver.command({ type: "effect.begin", effectId });
        atomic(receiptPath, { state: "unknown", url: null });
        const bodyPath = join(stateHome(), "effects", `${effectId}.body.txt`);
        // A private file, not shell interpolation or a command-line token.
        const fs = await import("node:fs");
        fs.writeFileSync(bodyPath, payload.body, { mode: 0o600 });
        const output = gh(["pr", "create", "--repo", name, "--head", branch, "--base", options.base, "--title", options.title, "--body-file", bodyPath], cwd);
        const urls = output.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g) ?? [];
        demand(urls.length === 1, "EXTERNAL_EFFECT_UNKNOWN", "No unique PR URL returned; reconcile before retrying");
        receipt = { state: "succeeded", url: urls[0]! };
    }
    atomic(receiptPath, receipt);
    await resolver.command({ type: "effect.resolve", effectId, state: "succeeded", result: receipt.url }, { id: `resolve-${effectId}${toolSuffix}`, queue: true });
    return syncPr(cfg, repo, Number(receipt.url!.split("/").at(-1)), effectId);
}
