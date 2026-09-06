#!/usr/bin/env bun
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { Client, syncOutbox, pendingCount } from "./client.js";
import { context, stateHome, atomic, readJson, type Connection } from "./files.js";
import { Fault, demand, uid } from "../domain/util.js";
import { launch, runtimeEvent, processIdentity } from "../runtime/launcher.js";
import { installHooks, hooksStatus, uninstallHooks, gitHook, checkRange, contribute } from "../git/hooks.js";
import { head, repository } from "../git/repository.js";
import { textView, workpad, mermaid, type View } from "../projections/views.js";
import { parseChecklist, legacyReadiness } from "../importers/checklist.js";
import { createPr, syncPr } from "../integrations/github.js";
import type { State } from "../domain/model.js";
const help = `wr-next — isolated work coordination and provenance

  authority stop                         Stop the managed local authority
  serve [--port N] [--database PATH]       Local authority (loopback only)
  connect --server URL --workspace KEY --token-file PATH
  add TITLE [--under W] [--needs W1,W2] [--link REF]
  plan --file FILE                        Atomic typed plan changes
  run W [--runtime generic|claude] [--read-only] [--role ROLE] -- COMMAND...
  status [W] [--format json] [--since CURSOR]
  report [W] --decision TEXT [--reason TEXT]
  report [W] --blocked TEXT | --progress TEXT
  done [W] --summary TEXT                 Submit; never blindly complete
  hold resolve ID --reason TEXT
  cancel W --reason TEXT | reopen W --reason TEXT
  recover EXEC --stopped --reason TEXT    Explicit stopped-process recovery
  agents [--format mermaid]               Runtime tree, separate from the work DAG
  graph [W] | export [W] [--output FILE]   Generated Mermaid / workpad
  hooks install|status|uninstall          Preserve existing Git hooks
  contribute EXEC [--identity 'Name <email>']
  provenance sync|check [RANGE]
  verify [W] --check NAME -- COMMAND...   Run and record exact-HEAD check
  pr create [W] --title TITLE [--body-file PATH] [--base main]
  pr sync NUMBER --repo OWNER/REPO
  explain commit [REV] | explain pr NUMBER --repo OWNER/REPO
  import FILE [--apply]                   Read-only by default
  shadow FILE --source SOURCE
  cutover SOURCE --confirm W --comparison FILE
  rollback SOURCE --confirm W
  doctor

No existing wr database, configuration, binary or release is modified.
`;
type Args = {
    pos: string[];
    opts: Record<string, string | boolean>;
    tail: string[];
};
function args(argv: string[]): Args {
    const out: Args = { pos: [], opts: {}, tail: [] };
    const booleans = new Set(["read-only", "apply", "stopped", "json", "help", "replan"]);
    const valued = new Set(["port", "database", "workspace", "server", "token-file", "under", "needs", "link", "description", "lane", "checks", "file", "runtime", "role", "continue", "session", "worktree", "since", "offset", "format", "output", "decision", "reason", "blocked", "progress", "summary", "check", "repo", "title", "body-file", "base", "operation", "source", "confirm", "comparison", "identity"]);
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]!;
        if (a === "--") {
            out.tail = argv.slice(i + 1);
            break;
        }
        if (a.startsWith("--")) {
            const key = a.slice(2);
            demand(booleans.has(key) || valued.has(key), "INVALID_ARGUMENT", `Unknown option ${a}`, 400);
            demand(out.opts[key] === undefined, "INVALID_ARGUMENT", `Duplicate option ${a}`, 400);
            if (booleans.has(key))
                out.opts[key] = true;
            else {
                const v = argv[++i];
                demand(v !== undefined && !v.startsWith("--"), "INVALID_ARGUMENT", `Missing value for ${a}`, 400);
                out.opts[key] = v;
            }
        }
        else
            out.pos.push(a);
    }
    return out;
}
const opt = (a: Args, key: string): string | undefined => typeof a.opts[key] === "string" ? a.opts[key] as string : undefined;
const required = (a: Args, key: string) => { const v = opt(a, key); demand(v, "INVALID_ARGUMENT", `--${key} required`, 400); return v; };
const json = (value: unknown) => console.log(JSON.stringify(value, null, 2));
const workQuery = (work?: string) => work ? `?work=${encodeURIComponent(work)}` : "";
async function stdin(): Promise<string> {
    let result = "";
    for await (const chunk of process.stdin) {
        result += chunk;
        demand(result.length < 1024 * 1024, "PAYLOAD_TOO_LARGE", "Input too large", 413);
    }
    return result;
}
function generatedOutput(path: string, body: string): void {
    if (existsSync(path))
        demand(readFileSync(path, "utf8").startsWith("<!-- wr-next generated"), "NOT_GENERATED", "Refusing to overwrite a hand-written workpad");
    writeFileSync(path, body, { mode: 0o600 });
}
export async function main(argv = process.argv.slice(2)): Promise<number> {
    const a = args(argv), [cmd, sub] = a.pos;
    if (!cmd || cmd === "help" || a.opts.help) {
        console.log(help);
        return 0;
    }
    if (cmd === "internal") {
        try {
            if (sub === "git-hook") {
                const name = a.pos[2]!;
                await gitHook(process.cwd(), name, a.pos.slice(3), ["post-rewrite", "pre-push"].includes(name) ? await stdin() : "");
            }
            else if (sub === "runtime-event")
                await runtimeEvent(await stdin());
            else
                throw new Fault("INVALID_ARGUMENT", "Unknown internal command", 400);
        }
        catch (e) {
            console.error(`wr-next hook: ${e instanceof Error ? e.message : "failed"}`);
        }
        return 0;
    }
    if (cmd === "serve") {
        demand(!context(), "FORBIDDEN", "Managed workers cannot start an authority", 403);
        const { startLocal } = await import("../server/local.js");
        const dir = stateHome();
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const cfgPath = join(dir, "connection.json"), previous = existsSync(cfgPath) ? readJson<Connection>(cfgPath) : null;
        const localPrevious = previous && new URL(previous.server).hostname === "127.0.0.1" ? previous : null;
        const secret = localPrevious?.token ?? randomBytes(32).toString("hex"), ws = opt(a, "workspace") ?? "local";
        const server = await startLocal({ database: opt(a, "database") ?? join(dir, "workspace.sqlite"), secret, workspace: ws, port: Number(opt(a, "port") ?? 47832) });
        atomic(cfgPath, { server: server.url, workspace: ws, device: localPrevious?.device ?? uid("device"), token: secret, localAuthority: { database: resolve(opt(a, "database") ?? join(dir, "workspace.sqlite")), pid: process.pid, processIdentity: processIdentity(process.pid) } });
        console.log(`wr-next listening on ${server.url} (credentials saved privately)`);
        await new Promise<void>(resolve => { process.once("SIGTERM", resolve); process.once("SIGINT", resolve); });
        await server.close();
        return 0;
    }
    if (cmd === "connect") {
        demand(!context(), "FORBIDDEN", "Managed workers cannot change the authority connection", 403);
        const server = required(a, "server"), url = new URL(server);
        demand(url.protocol === "https:" || url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname), "UNSAFE_SERVER", "Remote authority must use HTTPS");
        atomic(join(stateHome(), "connection.json"), { server, workspace: required(a, "workspace"), device: uid("device"), token: readFileSync(required(a, "token-file"), "utf8").trim() });
        console.log("Connection saved; no token printed");
        return 0;
    }
    if (cmd === "hooks") {
        demand(["install", "status", "uninstall"].includes(sub ?? ""), "INVALID_ARGUMENT", "Unknown hooks command", 400);
        json(sub === "install" ? installHooks(process.cwd()) : sub === "uninstall" ? uninstallHooks(process.cwd()) : hooksStatus(process.cwd()));
        return 0;
    }
    if (cmd === "contribute") {
        demand(sub, "INVALID_ARGUMENT", "Execution required");
        contribute(process.cwd(), sub, opt(a, "identity"));
        console.log("Contributor recorded for the next commit");
        return 0;
    }
    if (cmd === "provenance") {
        demand(["sync", "check"].includes(sub ?? ""), "INVALID_ARGUMENT", "Unknown provenance command", 400);
        if (sub === "sync") {
            json(await syncOutbox());
            return 0;
        }
        const r = checkRange(process.cwd(), a.pos[2] ?? "HEAD") as {
            commits: {
                tracked: boolean;
            }[];
        };
        json(r);
        return r.commits.every(c => c.tracked) ? 0 : 2;
    }
    if (cmd === "authority") {
        demand(sub === "stop", "INVALID_ARGUMENT", "Use authority stop", 400);
        const { stopLocalAuthority } = await import("./authority.js");
        await stopLocalAuthority();
        console.log("Local authority stopped");
        return 0;
    }
    const known = new Set(["add", "plan", "run", "status", "report", "done", "hold", "cancel", "reopen", "recover", "graph", "export", "hooks", "contribute", "provenance", "verify", "pr", "explain", "import", "shadow", "cutover", "rollback", "doctor", "agents"]);
    demand(known.has(cmd), "INVALID_ARGUMENT", `Unknown command ${cmd}; run --help`, 400);
    const { ensureConnection } = await import("./authority.js");
    const cfg = await ensureConnection(), client = new Client(cfg);
    if (cmd === "run") {
        demand(sub, "INVALID_ARGUMENT", "Select work");
        demand(["generic", "claude"].includes(opt(a, "runtime") ?? "generic"), "UNSUPPORTED_RUNTIME", "Supported adapter kinds: generic, claude", 400);
        const result = await launch(cfg, { work: sub, argv: a.tail, runtime: opt(a, "runtime"), role: opt(a, "role"), readOnly: Boolean(a.opts["read-only"]), continuedFrom: opt(a, "continue"), session: opt(a, "session"), worktree: opt(a, "worktree") });
        json(result);
        return result.exitCode;
    }
    if (cmd === "add") {
        demand(sub, "INVALID_ARGUMENT", "Title required");
        json(await client.command({ type: "work.create", title: sub, parent: opt(a, "under"), replan: Boolean(a.opts.replan), needs: opt(a, "needs")?.split(","), links: opt(a, "link") ? [opt(a, "link")] : [], description: opt(a, "description"), lane: opt(a, "lane"), policy: opt(a, "checks") ? { name: "evidence-v1", checks: opt(a, "checks")!.split(",") } : undefined }));
        return 0;
    }
    if (cmd === "plan") {
        const changes = readJson<unknown>(required(a, "file"));
        const v = await client.request<View>("/v1/status");
        json(await client.command({ type: "work.plan", changes }, { revision: v.revision }));
        return 0;
    }
    if (["status", "graph", "export"].includes(cmd)) {
        const params = new URLSearchParams();
        if (sub)
            params.set("work", sub);
        if (opt(a, "since"))
            params.set("since", opt(a, "since")!);
        if (opt(a, "offset"))
            params.set("offset", opt(a, "offset")!);
        const v = await client.request<View>(`/v1/status?${params}`);
        if (cmd === "graph")
            console.log(mermaid(v));
        else if (cmd === "export") {
            const body = workpad(v);
            if (opt(a, "output"))
                generatedOutput(opt(a, "output")!, body);
            else
                console.log(body);
        }
        else if (opt(a, "format") === "json" || a.opts.json)
            json({ ...v, pendingSync: pendingCount() });
        else
            console.log(textView(v));
        return 0;
    }
    if (cmd === "report") {
        const kind = a.opts.decision ? "decision" : a.opts.blocked ? "blocked" : "progress";
        json(await client.command({ type: "work.report", work: sub, kind, summary: required(a, kind), reason: opt(a, "reason") }, { queue: true }));
        return 0;
    }
    if (cmd === "done") {
        await syncOutbox();
        let artifacts: {
            repo: string;
            sha: string;
        }[] = [];
        const commit = head(process.cwd());
        if (commit)
            artifacts = [{ repo: repository(process.cwd()), sha: commit }];
        json(await client.command({ type: "result.submit", work: sub, summary: required(a, "summary"), manifest: artifacts }, { queue: true }));
        return 0;
    }
    if (cmd === "cancel" || cmd === "reopen") {
        json(await client.command({ type: `work.${cmd}`, work: sub, reason: required(a, "reason") }));
        return 0;
    }
    if (cmd === "hold" && sub === "resolve") {
        json(await client.command({ type: "hold.resolve", hold: a.pos[2], reason: required(a, "reason") }));
        return 0;
    }
    if (cmd === "recover") {
        json(await client.command({ type: "execution.recover", execution: sub, stopped: Boolean(a.opts.stopped), reason: required(a, "reason") }));
        return 0;
    }
    if (cmd === "verify") {
        const work = await client.request<any>(`/v1/work${workQuery(sub)}`), result = work.results.at(-1);
        demand(result, "NO_RESULT", "Submit a result before verification");
        demand(a.tail.length, "INVALID_ARGUMENT", "Command required after --");
        const check = required(a, "check"), before = head(process.cwd());
        demand(before && result.manifest.some((r: any) => r.sha === before && r.repo === repository(process.cwd())), "ARTIFACT_CHANGED", "Working HEAD does not match submitted result");
        const cap = await client.request<{
            token: string;
        }>("/v1/capabilities", { execution: result.execution ?? undefined, checks: [check] });
        const processResult = spawnSync(a.tail[0]!, a.tail.slice(1), { stdio: "inherit", cwd: process.cwd() });
        const after = head(process.cwd());
        const clean = spawnSync("git", ["status", "--porcelain"], { encoding: "utf8" });
        const passed = processResult.status === 0 && before === after && !clean.stdout.trim();
        json(await new Client({ ...cfg, ...(!cfg.accessToken && !cfg.token.startsWith("wn1.") && cfg.token.split(".").length === 3 ? { accessToken: cfg.token } : {}), token: cap.token }).command({ type: "check.record", result: result.id, name: check, subject: result.subject, status: passed ? "passed" : "failed", evidence: `local-check:${check}:${before}` }, { observed: true, queue: true }));
        return passed ? 0 : 2;
    }
    if (cmd === "pr") {
        if (sub === "sync")
            json(await syncPr(cfg, required(a, "repo"), Number(a.pos[2])));
        else if (sub === "create")
            json(await createPr(cfg, { work: a.pos[2], title: required(a, "title"), body: opt(a, "body-file") ? readFileSync(opt(a, "body-file")!, "utf8") : "", base: opt(a, "base") ?? "main", effectId: opt(a, "operation") }));
        else
            throw new Fault("INVALID_ARGUMENT", "Unknown PR command", 400);
        return 0;
    }
    if (cmd === "explain") {
        demand(["commit", "pr"].includes(sub ?? ""), "INVALID_ARGUMENT", "Unknown explain command", 400);
        if (sub === "commit") {
            const repo = repository(process.cwd());
            const { readCommit } = await import("../git/repository.js");
            const commit = readCommit(process.cwd(), a.pos[2] ?? "HEAD");
            json(await client.request(`/v1/explain/commit?repo=${encodeURIComponent(repo)}&sha=${commit.sha}`));
        }
        else {
            const r = required(a, "repo");
            json(await client.request(`/v1/explain/pr?repo=${encodeURIComponent(r.startsWith("github.com/") ? r : `github.com/${r}`)}&number=${Number(a.pos[2])}`));
        }
        return 0;
    }
    if (cmd === "import") {
        demand(sub, "INVALID_ARGUMENT", "Checklist file required");
        const report = parseChecklist(readFileSync(sub, "utf8"), opt(a, "source") ?? basename(sub));
        if (!a.opts.apply) {
            json(report);
            return report.errors.length ? 2 : 0;
        }
        demand(!report.errors.length, "UNSUPPORTED_IMPORT", report.errors.map(e => e.message).join("; "));
        const { errors: _e, warnings: _w, ...data } = report;
        json(await client.command({ type: "import.apply", ...data }));
        return 0;
    }
    if (cmd === "shadow") {
        demand(sub, "INVALID_ARGUMENT", "Checklist file required");
        const source = required(a, "source"), report = parseChecklist(readFileSync(sub, "utf8"), source);
        const state = await client.request<State>("/v1/snapshot"), stored = state.sources[source];
        demand(stored, "NOT_FOUND", "Source not imported");
        const differences: string[] = [];
        if (report.digest !== stored.digest)
            differences.push("source_changed");
        if (report.errors.length)
            differences.push(...report.errors.map(x => x.code));
        const old = legacyReadiness(report);
        const { reasons } = await import("../domain/work.js");
        for (const [key, id] of Object.entries(stored.mapping)) {
            const w = state.work[id]!;
            const readyOld = old[key]?.length === 0, readyNew = reasons(state, w).length === 0;
            if (readyOld !== readyNew)
                differences.push(`No.${key}: readiness differs`);
        }
        const comparison = { revision: state.meta.revision, sourceDigest: report.digest, differences };
        if (opt(a, "output"))
            atomic(opt(a, "output")!, comparison);
        json(comparison);
        return differences.length ? 2 : 0;
    }
    if (cmd === "cutover" || cmd === "rollback") {
        json(await client.command({ type: "migration.mode", source: sub, mode: cmd === "cutover" ? "next" : "legacy", confirm: required(a, "confirm"), comparison: cmd === "cutover" ? readJson(required(a, "comparison")) : undefined }));
        return 0;
    }
    if (cmd === "agents") {
        const format = opt(a, "format") ?? "json";
        demand(format === "json" || format === "mermaid", "INVALID_ARGUMENT", "agents supports json or mermaid", 400);
        const graph = await client.request<import("../projections/runtime.js").RuntimeView>("/v1/runtime");
        if (format === "mermaid") {
            const { runtimeMermaid } = await import("../projections/runtime.js");
            console.log(runtimeMermaid(graph));
        }
        else
            json(graph);
        return 0;
    }
    if (cmd === "doctor") {
        const v = await client.request<View>("/v1/status");
        json({ connected: true, revision: v.revision, pending: pendingCount(), context: context()?.key ?? null, node: process.version, git: spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0, gh: spawnSync("gh", ["--version"], { encoding: "utf8" }).status === 0 });
        return 0;
    }
    throw new Fault("INVALID_ARGUMENT", `Unknown command ${cmd}; run --help`, 400);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main().then(code => { process.exitCode = code; }).catch(error => { console.error(JSON.stringify({ error: { code: error instanceof Fault ? error.code : "FAILED", message: error instanceof Error ? error.message : "Operation failed" } })); process.exitCode = error instanceof Fault && error.code === "PENDING_SYNC" ? 3 : 1; });
}
