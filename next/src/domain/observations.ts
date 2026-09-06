import type { State, Principal, CommitSnapshot, Artifact, PullRequest } from "./model.js";
import { demand, digest, uid, values, now, manifest, Fault } from "./util.js";
import { emit } from "./work.js";
import { text, object, integer, list, choice, flag, optionalText, type ObjectValue } from "../protocol/validate.js";
function sha(x: unknown): string { const v = text(x, "sha", 64); demand(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(v), "INVALID_SHA", "Full SHA required", 400); return v; }
function scopedExecution(s: State, p: Principal, id?: string) { const e = s.executions[id ?? p.execution ?? ""]; demand(e, "NOT_FOUND", "Observation execution not found", 404); demand(!p.execution || p.execution === e.id, "FORBIDDEN", "Observation outside collector scope", 403); return e; }
function recordCheck(s: State, p: Principal, c: ObjectValue): unknown {
    demand(p.role === "collector", "UNAUTHORIZED_OBSERVATION", "Check requires collector", 403);
    const result = s.results[text(c.result, "result")];
    demand(result, "NOT_FOUND", "Result not found", 404);
    const name = text(c.name, "check name", 200);
    demand(p.checks?.includes(name) || p.checks?.includes("github:*") && (name.startsWith("ci:") || name === "review:independent"), "UNAUTHORIZED_OBSERVATION", "Collector not allowed for this check", 403);
    if (p.execution)
        demand(result.execution === p.execution, "FORBIDDEN", "Result outside collector scope", 403);
    const target = text(c.subject, "subject");
    demand(result.subject === target, "SUBJECT_MISMATCH", "Check does not match submitted artifact", 409);
    const previous = values(s.checks).filter(k => k.result === result.id && k.name === name && k.subject === target).at(-1);
    const status = choice(c.status, ["passed", "failed", "pending"] as const), evidence = optionalText(c.evidence, "evidence") ?? null;
    if (previous && previous.status === status && previous.evidence === evidence && previous.collector === p.id)
        return { id: previous.id, unchanged: true };
    const id = uid("check");
    s.checks[id] = { id, result: result.id, name, subject: target, status: choice(c.status, ["passed", "failed", "pending"] as const), collector: p.id, evidence: optionalText(c.evidence, "evidence") ?? null, observedAt: now() };
    emit(s, p, "check.recorded", { id, name, status: s.checks[id]!.status, subject: target }, result.work, "observed");
    return { id };
}
export function applyObservation(s: State, p: Principal, c: ObjectValue & {
    type: string;
}): unknown {
    switch (c.type) {
        case "check.record": return recordCheck(s, p, c);
        case "runtime.event": {
            const e = scopedExecution(s, p, optionalText(c.execution, "execution")), run = s.runs[e.run]!;
            const event = choice(c.event, ["started", "heartbeat", "window", "ended", "launch_failed", "unknown"] as const);
            if (c.externalSessionId !== undefined) {
                const externalId = text(c.externalSessionId, "externalSessionId", 300);
                const sid = digest({ runtime: run.runtime, externalId, device: run.device });
                if (run.session)
                    demand(s.sessions[run.session]?.externalId === externalId, "SESSION_CONFLICT", "Do not rebind an existing run's session");
                s.sessions[sid] = { id: sid, runtime: run.runtime, externalId, device: run.device };
                run.session = sid;
            }
            if (event === "window") {
                const window = text(c.windowId, "windowId", 200);
                if (!run.windows.includes(window))
                    run.windows.push(window);
            }
            if (event === "unknown")
                run.state = "unknown";
            if (event === "ended" || event === "launch_failed") {
                const exit = c.exitCode === undefined ? null : integer(c.exitCode, "exitCode", 0, 255);
                // Late process observations cannot undo recovery/fencing.
                if (e.state === "active") {
                    e.state = event === "launch_failed" || exit !== 0 ? "failed" : values(s.results).some(r => r.execution === e.id) ? "finished" : "interrupted";
                    e.endedAt = now();
                    for (const r of values(s.reservations))
                        if (r.execution === e.id)
                            r.state = "released";
                }
                if (!values(s.executions).some(x => x.run === run.id && x.state === "active")) {
                    run.state = "ended";
                    run.endedAt = now();
                }
            }
            emit(s, p, `runtime.${event}`, { run: run.id, execution: e.id, windowId: c.windowId, exitCode: c.exitCode, signal: c.signal }, e.work, "observed");
            return { run: run.id, execution: e.id, state: e.state };
        }
        case "git.commit": {
            demand(p.role === "collector" && p.checks?.includes("git:*"), "UNAUTHORIZED_OBSERVATION", "Git collector required", 403);
            const raw = object(c.commit, ["repo", "sha", "tree", "parents", "subject", "author", "committer", "context"]);
            const repo = text(raw.repo, "repo", 400), commitSha = sha(raw.sha), tree = sha(raw.tree), id = `${repo}@${commitSha}`;
            const gaps: string[] = [];
            let ctx: string | null = null;
            let snapshot: CommitSnapshot | undefined;
            if (c.snapshot !== null && c.snapshot !== undefined) {
                const x = object(c.snapshot, ["id", "work", "execution", "scopeRevision", "generation", "repo", "tree", "base", "branch", "capturedAt", "contributors", "originCommit"]);
                snapshot = { id: text(x.id, "context id", 200), work: text(x.work, "work"), execution: text(x.execution, "execution"), scopeRevision: integer(x.scopeRevision, "scopeRevision", 1), generation: integer(x.generation, "generation", 1), repo: text(x.repo, "repo", 400), tree: sha(x.tree), base: x.base === null ? null : sha(x.base), branch: x.branch === null ? null : text(x.branch, "branch", 500), capturedAt: text(x.capturedAt, "capturedAt", 80), contributors: list(x.contributors ?? [], x => text(x, "contributor")), ...(x.originCommit ? { originCommit: sha(x.originCommit) } : {}) };
                const e = scopedExecution(s, p, snapshot.execution);
                if (digest(snapshot) !== c.snapshotDigest)
                    gaps.push("context_digest_mismatch");
                if (snapshot.work !== e.work || snapshot.scopeRevision !== e.scopeRevision || snapshot.generation !== e.generation)
                    gaps.push("context_binding_mismatch");
                if (snapshot.repo !== repo)
                    gaps.push("repository_mismatch");
                if (snapshot.tree !== tree)
                    gaps.push("tree_mismatch");
                const existing = s.contexts[snapshot.id];
                if (existing && existing.digest !== c.snapshotDigest)
                    gaps.push("immutable_context_conflict");
                if (!gaps.length) {
                    ctx = snapshot.id;
                    s.contexts[ctx] = { id: ctx, snapshot, digest: text(c.snapshotDigest, "snapshotDigest") };
                }
            }
            else
                gaps.push("context_missing");
            const previous = s.artifacts[id];
            if (previous)
                demand(previous.tree === tree, "IMMUTABLE_ARTIFACT", "Commit SHA cannot change tree");
            const artifact: Artifact = { id, repo, sha: commitSha, tree, parents: list(raw.parents, x => sha(x)), subject: text(raw.subject ?? "", "subject", 2000, true), author: text(raw.author ?? "", "author", 1000, true), committer: text(raw.committer ?? "", "committer", 1000, true), context: ctx ?? previous?.context ?? null, gaps: ctx ? [] : previous?.context ? previous.gaps : gaps, observedAt: now() };
            s.artifacts[id] = artifact;
            const add = (execution: string | null, relation: "committed_by" | "implemented_by" | "observed_by", source: "declared" | "observed") => { const cid = digest({ id, execution, relation }); s.contributions[cid] = { id: cid, artifact: id, execution, relation, source, evidence: ctx ?? "collector" }; };
            add(p.execution ?? null, "observed_by", "observed");
            if (ctx && snapshot) {
                add(snapshot.execution, "committed_by", "observed");
                for (const contributor of snapshot.contributors) {
                    if (!s.executions[contributor]) {
                        gaps.push(`unknown_contributor:${contributor}`);
                        continue;
                    }
                    add(contributor, "implemented_by", "declared");
                }
                artifact.gaps = [...new Set([...artifact.gaps, ...gaps])];
                const e = s.executions[snapshot.execution]!, w = s.work[e.work]!;
                if (e.state === "active" && w.scopeRevision === e.scopeRevision) {
                    w.candidate = manifest([{ repo, sha: commitSha }]);
                    w.revision++;
                    w.updatedAt = now();
                }
            }
            emit(s, p, "git.commit", { artifact: id, context: ctx, gaps }, snapshot?.work ?? null, "observed");
            return { id, gaps };
        }
        case "git.rewrite": {
            demand(p.role === "collector" && p.checks?.includes("git:*"), "UNAUTHORIZED_OBSERVATION", "Git collector required", 403);
            const e = p.execution ? scopedExecution(s, p) : null, repo = text(c.repo, "repo", 400), operation = choice(c.operation, ["amend", "rebase", "cherry-pick", "squash"] as const);
            const pairs = list(c.pairs, v => { const x = object(v, ["old", "new"]); return { old: sha(x.old), new: sha(x.new) }; });
            for (const pair of pairs) {
                const id = digest({ repo, ...pair, operation });
                s.rewrites[id] = { id, repo, ...pair, operation, execution: e?.id ?? null, observedAt: now() };
                const oldId = `${repo}@${pair.old}`, newId = `${repo}@${pair.new}`;
                for (const old of values(s.contributions).filter(x => x.artifact === oldId && x.relation === "implemented_by")) {
                    const cid = digest({ newId, execution: old.execution, relation: old.relation });
                    s.contributions[cid] = { ...old, id: cid, artifact: newId, source: "derived", evidence: id };
                }
                if (e) {
                    const relation = operation === "rebase" ? "rebased_by" : operation === "amend" ? "amended_by" : "integrated_by";
                    const cid = digest({ newId, execution: e.id, relation });
                    s.contributions[cid] = { id: cid, artifact: newId, execution: e.id, relation, source: "observed", evidence: id };
                }
            }
            emit(s, p, "git.rewrite", { repo, operation, pairs }, e?.work ?? null, "observed");
            return { count: pairs.length };
        }
        case "github.sync": {
            demand(p.role === "collector" && p.checks?.includes("github:*"), "UNAUTHORIZED_OBSERVATION", "GitHub collector required", 403);
            const x = object(c.pullRequest, ["repo", "number", "url", "title", "author", "head", "base", "state", "draft", "commits", "reviews", "checks", "updatedAt"]);
            const repo = text(x.repo, "repo", 300), number = integer(x.number, "number", 1), id = `${repo}#${number}`, head = sha(x.head);
            const updatedAt = text(x.updatedAt, "updatedAt", 80), old = s.prs[id];
            if (old && old.updatedAt > updatedAt)
                return { id, ignored: "older_snapshot" };
            const commits = list(x.commits, v => sha(v));
            const url = text(x.url, "url", 2000);
            demand(url === `https://github.com/${repo.replace(/^github.com\//, "")}/pull/${number}`, "INVALID_URL", "PR URL does not match identity", 400);
            let publisher = old?.publisher ?? null;
            if (c.effectId !== undefined) {
                const effect = s.effects[text(c.effectId, "effectId")];
                demand(effect && effect.kind === "pr.create" && effect.state === "succeeded" && effect.result === url && effect.payload.repo === repo, "EFFECT_MISMATCH", "Publisher requires a matching successful PR creation receipt");
                if (p.execution)
                    demand(effect.execution === p.execution, "FORBIDDEN", "Effect outside collector scope", 403);
                publisher = effect.execution;
            }
            const reviews = list(x.reviews, v => { const r = object(v, ["id", "author", "sha", "state"]); return { id: text(r.id, "reviewId"), author: text(r.author, "author"), sha: sha(r.sha), state: text(r.state, "state", 80) }; });
            const checks = list(x.checks, v => { const r = object(v, ["name", "sha", "status"]); return { name: text(r.name, "check", 200), sha: sha(r.sha), status: choice(r.status, ["passed", "failed", "pending"] as const) }; });
            const pr: PullRequest = { id, repo, number, url, title: text(x.title, "title", 1000), author: x.author === null ? null : text(x.author, "author"), head, base: text(x.base, "base", 500), state: choice(x.state, ["open", "closed", "merged"] as const), draft: flag(x.draft), commits, reviews, checks, publisher, observer: p.execution ?? p.id, updatedAt, snapshots: old?.snapshots ?? [] };
            if (!old || old.head !== head || JSON.stringify(old.commits) !== JSON.stringify(commits))
                pr.snapshots.push({ head, commits: [...commits], observedAt: now() });
            s.prs[id] = pr;
            // A PR created for a work item advances its candidate version. Old checks stay historical.
            const linked = values(s.effects).filter(effect => effect.kind === "pr.create" && effect.state === "succeeded" && effect.result === url);
            for (const effect of linked) {
                if (p.execution && effect.execution !== p.execution)
                    continue;
                const work = s.work[effect.work];
                if (work) {
                    work.candidate = manifest([{ repo, sha: head }]);
                    work.revision++;
                    work.updatedAt = now();
                }
            }
            for (const r of values(s.results).filter(r => r.manifest.some(a => a.repo === repo && a.sha === head))) {
                if (p.execution && r.execution !== p.execution)
                    continue;
                for (const check of checks.filter(k => k.sha === head))
                    recordCheck(s, p, { result: r.id, name: `ci:${check.name}`, subject: r.subject, status: check.status, evidence: url });
                const reviewerStates = new Map<string, string>();
                for (const review of reviews.filter(v => v.sha === head && v.author !== pr.author)) {
                    if (["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state))
                        reviewerStates.set(review.author, review.state);
                }
                const states = [...reviewerStates.values()];
                const status = states.includes("CHANGES_REQUESTED") ? "failed" : states.includes("APPROVED") ? "passed" : "pending";
                recordCheck(s, p, { result: r.id, name: "review:independent", subject: r.subject, status, evidence: url });
            }
            emit(s, p, "github.synced", { id, head, commitCount: commits.length }, null, "observed");
            return { id };
        }
        default: throw new Fault("INVALID_OPERATION", `Not an observation: ${c.type}`, 400);
    }
}
