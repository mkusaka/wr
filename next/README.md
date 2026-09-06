# wr-next

An isolated successor to `wr`. People and agents manage **work**, not session IDs or Markdown ledgers.

- Hierarchical work and dependency planning, with atomic claims and resource reservations.
- Runs and executions are separate from work. Resume and retry preserve earlier attempts.
- `done` submits a result. Acceptance records why that exact scope/artifact satisfied its policy.
- Local Git capture, immutable context snapshots, rewrite lineage, explicit co-author declarations.
- GitHub PR/commit/review/check synchronization, with safe creation receipts.
- Deterministic status, workpad and Mermaid projections; no LLM calls to generate views.
- A read-only checklist importer, shadow comparisons, and explicit scope authority transitions.

**Status:** implementation and local tests are available. Real provider calls, actual workerd execution and production dogfood must be validated separately; see [verification](docs/verification.md). This does not replace an installed `wr`, deploy a Worker, migrate old D1 data, or modify old hook configuration automatically.

## Install and verify

Requires Bun **1.4.2** and Git. Runtime modules use Bun and Bun-compatible built-ins; development dependencies are pinned in `bun.lock`.

```sh
cd next
bun ci
bun run verify
./bin/wr-next --help
```

`bun run verify` runs formatting, strict types/unused-symbol checks, architecture lint, tests, the minimal demo and a local integration proof. Tests make no real model or GitHub API calls. The integration proof uses actual Git, SQLite and processes but **synthetic** agent and PR data.

An explicit package install or symlink can expose `bin/wr-next` on PATH. Nothing installs over `wr`.

## Start a local authority

In terminal A:

```sh
./bin/wr-next serve
```

The server listens only on loopback, creates an owner-private SQLite database and writes a random local credential to `~/.local/state/wr-next/connection.json`. `WR_NEXT_HOME` selects an isolated state directory. Every participating local CLI must use the same setting.

In terminal B:

```sh
wr-next add "Improve the API"
# result.key = W1
wr-next add "Implement the change" --under W1 --checks tests
# W2
wr-next add "Independent review" --under W1 --needs W2
# W3
wr-next status W1
wr-next graph W1
```

Use an independent worktree for each concurrent writer. Worktree creation is explicit:

```sh
wr-next run W2 --worktree ../api-worker --runtime claude -- claude
```

Without `--worktree`, `run` uses the current directory. It reserves the work and environment, injects a child-specific context, starts the process, and records its exit. It never treats exit zero as task completion.

`--runtime generic` works with arbitrary explicit subprocess commands, including an installed Codex or other CLI, but does not claim native session/rollover integration. `--runtime claude` additionally installs per-launch SessionStart/SessionEnd/PostToolUse settings. Native Claude compatibility is contract-tested; live validation is opt-in. No permission-bypass flags are added.

Inside a managed worker:

```sh
wr-next status
wr-next report --decision "Reuse the current API" --reason "Preserves its contract"
wr-next done --summary "Implemented the API change"
```

The worker does not specify Run, Execution, workspace, or revision IDs. If blocked:

```sh
wr-next report --blocked "Owner decision is required"
```

An operator runs the actual configured verification after submission, at the submitted HEAD:

```sh
wr-next verify W2 --check tests -- bun test
```

A successful check of a different SHA cannot complete this result. For a separate review work item, complete implementation at W2, then review W3; put the combined completion condition on the parent rather than creating a circular wait.

## Planning and concurrency

```sh
wr-next plan --file plan.json
```

The file is a list of typed changes, not replacement state:

```json
[
  {"type":"work.create","title":"Implement","alias":"implementation"},
  {"type":"work.create","title":"Review","needs":["implementation"]}
]
```

Plan changes include `work.create`, `work.update`, `dependency.add`, `dependency.remove`, `lane.set`, `work.cancel` and `work.reopen`. Use `replan: true` when changing active requirements or decomposing attempted work. A conflicting plan is rejected, never silently rebased.

Dependency and parent-aggregation cycles are rejected together. Cancel is not successful completion. Work has a current scope revision; old results, checks and acceptances remain historical after a scope/artifact change. Multiple executions per work and multiple works per run are supported internally. A reader may coexist with a writer, but read-only mode is a coordination declaration, **not an OS sandbox**.

## Git provenance

Opt in from each repository:

```sh
wr-next hooks install
wr-next hooks status
```

Existing hook files are backed up and chained; their failure status is retained. Existing `core.hooksPath` is not overwritten: integrate `wr-next internal git-hook HOOK_NAME` into that hook manager manually. `pre-push` and `post-rewrite` need the original stdin forwarded to each consumer.

Managed commits receive only stable pointers:

```text
WR-Work: work_<uuid>
WR-Context: context_<uuid>
```

Hooks record the effective staged index, commit/tree binding, and rewrite mappings. They do not wait for the remote authority during commit. `pre-push`, explicit sync, result submission and launcher shutdown flush the private outbox.

```sh
wr-next provenance sync
wr-next provenance check origin/main..HEAD
wr-next explain commit HEAD
wr-next hooks uninstall
```

`provenance check` currently checks local trailer coverage, not cryptographic authorship. `explain commit` includes binding gaps and rewrite evidence. A copied trailer without the original context is not promoted into a verified implementation claim.

Author and Committer are never changed. Co-authors are opt-in and require an explicit contributing execution and identity:

```sh
wr-next contribute exec_<known-contributor> --identity 'Contributor <verified-address>'
```

Do not list an orchestrator, observer, reviewer, or committer as a co-author solely because of that role. Identity is not inferred from email placeholders. This is operational provenance in a trusted local OS environment, not hostile-host attestation.

## GitHub

Requires an authenticated `gh`. No GitHub credential is bundled or read from the old `wr` config.

```sh
wr-next pr create W2 --title "Fix API" --body-file pr.md --base main
wr-next pr sync 123 --repo owner/repo
wr-next explain pr 123 --repo owner/repo
```

PR creation uses an authority-side effect claim, a private receipt and an operation marker. After ambiguous output it searches for that marker; it does not blindly create another PR. Concurrent creators cannot claim the same effect twice. `--operation SAFE_ID` selects a new explicit creation operation when intentionally reusing a branch/work association.

A PR head change invalidates the linked work's old candidate acceptance. Current commit membership is replaced; earlier snapshots remain. Reviews/checks are bound to the exact HEAD. Plain synchronization establishes an observer, not a publisher. Native Claude PostToolUse can notice a direct `gh pr create` URL, but only a matching creation receipt establishes agent publication.

## Import, shadow, cutover, rollback

```sh
wr-next import orchestration.md --source reception
wr-next import orchestration.md --source reception --apply
wr-next shadow orchestration.md --source reception --output comparison.json
wr-next cutover reception --confirm W1 --comparison comparison.json
wr-next rollback reception --confirm W1
```

Import is dry-run/read-only by default. The supported subset includes `needs`, `after`, exact `writes`, lane capacity, known states/stages and explicit owner gates. Original progress is retained as a **legacy claim**, not fabricated current acceptance.

Complex multi-pass/shipment evidence, unknown gates, globs and cycles that cannot be safely represented are rejected with diagnostics. The importer intentionally supports only the documented generic subset; it does not guess domain-specific legacy rules.

Shadow/legacy scopes cannot be mutated as current work. Cutover requires a fresh zero-difference comparison and no active/unknown legacy writers. Rollback preserves all new history and blocks further new-authority writes; it does **not** automatically update old Markdown or start old agents. Reconcile changes before resuming the old workflow.

## Remote authority

The production adapter is `src/server/cloudflare.ts`, one SQLite-backed Durable Object per workspace. It is separate from old D1. Defaults are fail-closed. Configure a new Worker, a private signing secret, Access issuer/audience and workspace subject memberships before any remote use.

```sh
wr-next connect --server https://NEW-HOST --workspace WORKSPACE --token-file /private/access-token
```

Access JWTs are cryptographically verified. Work capabilities are carried separately from the upstream Access bearer. Credentials are never printed. This version does not implement interactive Access OAuth renewal; expired transport/work credentials require explicit renewal. Pending observations remain private and are not reported as successful remote submission.

No production configuration, deployment, old schema migration, release, or `wr-next` to `wr` rename has been performed.

## Extra validation

```sh
# Real local workerd; may download the pinned Wrangler. Never deploys.
bun run test:workerd

# Explicitly opt in to quota-using provider verification and/or read-only GitHub access.
WR_NEXT_LIVE=1 WR_NEXT_LIVE_RUNTIME=claude bun run test:live
WR_NEXT_LIVE=1 WR_NEXT_LIVE_PR=owner/repo#123 bun run test:live
```

Live tests are skipped with a clear reason unless opted in. They do not silently use a fake provider. See [architecture](docs/architecture.md), [verification](docs/verification.md), and [rollout](docs/rollout.md).
