# wr-next

An isolated successor to `wr`. People and agents manage **work**, not session IDs or Markdown ledgers.

- Hierarchical work and dependency planning, with atomic claims and resource reservations.
- Runs and executions are separate from work. Resume and retry preserve earlier attempts.
- `done` submits a result. Acceptance records why that exact scope/artifact satisfied its policy.
- Local Git capture, immutable context snapshots, rewrite lineage, explicit co-author declarations.
- GitHub PR/commit/review/check synchronization, with safe creation receipts.
- Deterministic status, workpad and Mermaid projections; no LLM calls to generate views.
- A read-only checklist importer, shadow comparisons, and explicit scope authority transitions.

**Status:** implementation, local Bun tests and real workerd execution are available. Live provider calls, live GitHub synchronization and production dogfood remain separate acceptance gates; see [verification](docs/verification.md). This does not replace an installed `wr`, deploy a Worker, migrate old D1 data, or modify old hook configuration automatically.

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

## Initialize the repository once

```sh
wr-next init --dry-run
wr-next init
wr-next integrations
```

`init` detects installed executables/existing runtime directories without executing them. Select runtimes explicitly with `--runtime claude,codex,omp` (or `all`). Runtime-only setup uses `--no-git-hooks`. This is explicit repository opt-in; it never starts an authority, claims work, changes hook trust, or modifies another repository.

Static desired configuration lives in `.wr/config.json`. Only wr-next's own entries are merged into `.claude/settings.json` / `.codex/hooks.json`; OMP gets `.omp/extensions/wr-next.ts`. Existing settings/hooks are preserved. Codex `config.toml` is not rewritten. Review project and exact-hook trust in Codex `/hooks`; restart runtimes after changing integration settings.

```sh
wr-next integrations install codex
wr-next integrations sync
wr-next integrations uninstall codex
```

Installation, actual loading/trust, and native subagent binding are separate statuses. `init` does not claim all three are ready. See [repository integrations](docs/repository-integrations.md) for worktree handling, conflict recovery, and runtime limitations.

## Agent-managed coordination

Approve one local checkout/device once, then start Claude normally without choosing a Work ID:

```sh
wr-next init --agent-managed --runtime claude
# Optional operator-owned default verification policy:
# wr-next init --agent-managed --runtime claude --checks tests
claude
```

The root session starts as a scoped Coordinator without an implementation Execution or writer reservation. It can plan inside the approved repository scope, inspect deterministic ready candidates, and atomically claim one leaf:

```sh
wr-next status
wr-next plan --changes '[{"type":"work.create","title":"Implement the request"}]'
wr-next next --claim
wr-next report --decision "Reuse the existing API" --reason "Preserve its contract"
wr-next done --summary "Submitted the implementation"
```

Tool calls keep the Execution binding they received when dispatched; a late tool cannot follow the Coordinator onto another Work. Enrollment is private and device/authority-bound. Committed hook files alone grant no coordination authority. Plain-start bootstrap is currently implemented only for Claude; Codex and OMP use `wr-next run --next -- COMMAND` or a trusted `CoordinatorBridge`. See [agent-managed coordination](docs/agent-managed-coordination.md).

## Explicit operator-selected work

The existing local authority manager starts/reuses a private loopback authority on the first operator command. `WR_NEXT_HOME` selects the wr-next state directory. Every local client must use the same setting. Remote profiles remain remote; a connection failure does not create a different local authority.

```sh
wr-next add "Improve the API"
# result.key = W1
wr-next add "Implement the change" --under W1 --checks tests
# W2
wr-next add "Independent review" --under W1 --needs W2
# W3
wr-next status W1
wr-next graph W1

wr-next run W2 -- claude
# Or: wr-next run W2 -- codex / omp / devin
```

`run` infers the adapter from an exact executable basename (`claude`, `codex`, `omp`, `devin`). Custom wrappers can use `--runtime NAME`. It binds work, reserves the environment, creates Run/Execution, and injects private per-process context. Normal launches do **not** rewrite project files or add `--settings`.

Claude and Codex use their permanent project hooks; OMP uses its native extension. The adapters cover root lifecycle/startup guidance and targeted PR observations. Native child work still needs the trusted per-tool harness dispatcher; unsupported managed spawning is denied, not attributed to the parent. Devin is wrapper-only. Generic explicit subprocess execution remains available with `--runtime generic`; that opt-in does not claim native lifecycle capture.

OMP project extension discovery is cwd-local: launch from the initialized worktree root. Git worktrees have their own files; commit the shared static configuration or initialize each worktree explicitly. `run --worktree NEW_PATH` does not copy/overwrite integration files. If the new checkout lacks them, initialize it and then run from there; no work is claimed until preflight succeeds.

Explicit ephemeral Claude settings remain available for CI/testing:

```sh
wr-next run W2 --runtime claude --isolated -- claude
```

`--isolated` means isolated wr-next hook configuration, **not** an OS sandbox or a bypass of existing runtime settings/trust. Isolated Codex/OMP configuration is not implemented. No permission-bypass flag is added.

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

## Generic binder and native attachment

The normal `run` command composes worktree/integration preflight with a runtime-neutral binder. The binder only claims, issues context, spawns the exact prepared argv, and observes its direct child. It does not generate Claude/Codex/OMP configuration. The explicit Claude `--isolated` testing profile is prepared separately.

New runs use one private execution context; the duplicate lifecycle connection file is no longer generated. The same context issuer and bounded resume view are available to trusted native harnesses through `NativeRuntimeBridge`. Native-child assignment is not implied by installing project hooks.

A wrapperless harness can call `NativeRuntimeBridge.attach` with real session/actor/invocation identity, then `resumeContext` and `toolEnvironment`. There is no general session-ID-only CLI attach: without runtime cooperation that could bind the wrong resumed process or child. See [generic binder design](docs/generic-binder.md) for that boundary, normalized event semantics, and process-stop limitations.

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

`init` installs Git hooks unless `--no-git-hooks` is selected. Existing hook-manager configurations require manual integration and are never overwritten. Git capture can also be managed separately:

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

A PR head change invalidates the linked work's old candidate acceptance. Current commit membership is replaced; earlier snapshots remain. Reviews/checks are bound to the exact HEAD. Plain synchronization establishes an observer, not a publisher. Managed Claude/Codex/OMP tool observation can notice a direct `gh pr create` URL, but only a matching creation receipt establishes agent publication. A matching shell command alone never assigns a publisher.

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
