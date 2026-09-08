# Verification record

## Executed after integration

- Bun 1.4.2, TypeScript 5.8.3, real local Git and Bun SQLite.
- `bun ci` completed without lockfile changes.
- `bun run verify` completed: formatting, strict type checking, safety/architecture lint, 227 tests, the minimal demo and the local integration proof.
- `bun run test:workerd` completed against real local workerd, a SQLite-backed Durable Object and the capability gateway.
- The existing wr CI-equivalent checks completed: format, lint, typecheck, knip, 140 tests, compile and `./dist/wr --help`.

The local integration proof uses real child processes, Git hooks/commits, SQLite and HTTP. Synthetic provider processes cover all three tool-binding contracts. Installed OMP 18.1.13 additionally completed an actual two-child native task flow with the wr-next extension isolated: Alpha/W2 and Beta/W3 had distinct Execution IDs, the root had no Execution, both Works reached done, and native hub root/child and sibling messages were delivered. Both children successfully returned structured results through native `yield` and became quiescent. The CLI exited 0. No `wr-next run` substitution was used.

Historical stock Codex 0.153.4 evidence used a deterministic local Responses endpoint with real native spawn/wait, hook subprocesses and shell tools. Eight acceptance scenarios covered MAv1 startup/pre-tool correlation, reversed child tool order, missing assignment publication, explicit exit-2 denial, exit-1/malformed-output/runner-timeout fail-open behavior, and MAv2 correlation through exact persisted session metadata. This proves forkless runtime feasibility, not hosted-model behavior or the production-integrated wr-next native profile. Details and isolation conditions are in [repository integrations](repository-integrations.md#codex).

The production-integrated stock Codex 0.153.4 MAv1 smoke also passed: generated project hooks, real native tools, real shell processes, and the local authority bound two children to separate W2/W3 Executions. Child status was assignment-scoped; both Works reached done and children became quiescent, while the root had no Execution. Native root/child and sibling sends returned submission receipts, and native waits completed. Only Responses API model output was deterministic; hosted-model behavior remains untested. The temporary sandbox explicitly permitted wr state writes and authority networking, and `agents.max_depth = 2` exposed child messaging. See the integration guide for prerequisites and trust isolation.

## Covered behavior

- Work hierarchy, dependency and aggregate-cycle detection, atomic plan rollback, claims, reservations and lane capacity.
- Idempotent operations, stale scope/generation fencing and observation authorization.
- Result/acceptance separation, exact check subjects, revocation and upstream invalidation.
- Process failure, no-submission exit, live-writer reservation, context rollover and resume contracts.
- Partial commits, amend, rebase, autosquash, cherry-pick, co-author handling, chained hook behavior and uninstall.
- PR membership history, HEAD invalidation, review/check binding and duplicate creation reconciliation.
- Conservative legacy import, unsupported-semantics rejection, shadow comparison, cutover preconditions and rollback.
- Access JWT verification and the Cloudflare Durable Object adapter.
- Runtime-agent identity, exact-parent delegation, scoped read-only planning, per-child execution/capability binding and unassigned-child fail-closed behavior.
- Runtime lifecycle ordering, terminal-state fencing, quiescent/unknown/ended separation, orphan projection and Session identity reuse.
- Concurrent local-authority startup, authenticated reuse, locale-stable process identity, explicit stop and persistent-database restart.
- Runtime-neutral argv binding, allowlisted single-context issuance, direct-child supervision and correct spawn-failure/exit/signal separation.
- Permanent Claude/Codex/OMP repository integrations, ownership-aware reconciliation, worktree-local activation checks and fail-closed native guards; Codex status may report the MAv1 profile as project-read-only while activation remains not proven.
- Canonical macOS worktree identity and Bun-on-macOS signal-name normalization.
- Private, repository-scoped Coordinator enrollment with no artificial root Execution or ambient operator fallback.
- Deterministic ready selection, atomic claim/retry, per-tool WorkDispatch fencing and sequential Work ownership within one Run.
- Coordinator revocation, process-stop evidence, environment reservation retention, inherited leaf checks and schema-version-3 migration.
- Plain Claude/Codex/OMP bootstrap contracts through generated permanent hooks or extension, including per-tool input binding and runtime-specific permission behavior.
- Claude's explicit read-only child contract through real generated hook child processes: opaque assignment reference, serial prompt correlation, actual `agent_id`, dedicated Execution context, bounded tool allowlist, quiescent lifecycle and unassigned-child observation.
- Codex's explicit MAv1 read-only profile: reversed concurrent receipt publication, exact UUID binding, bounded missing-binding denial, isolated child context, replay handling, and rejection of foreign peers, ambiguous targets, arbitrary shell, nested spawning and writes. The installed Codex integrated smoke additionally exercised native spawn/send/wait and real Work completion.
- OMP 18.1.13 read-only native task binding through exact parent tool/index/child-session identity, with bounded child inspection and native hub conversation.

## Remaining external acceptance gates

- Installed Claude Code 2.1.263 executed the generated root SessionStart hook, but its model-driven child path could not run because the local OAuth session had expired. Codex's hosted-model path remains untested after an earlier account usage-limit failure; its integrated native MAv1 path passed with deterministic local model responses. OMP's isolated 18.1.13 native task/hub smoke passed; the earlier ordinary-user-plugin-stack smoke demonstrated a last-input-rewriter conflict and failed closed before claim. Arbitrary plugin compositions and writable/nested native child profiles are not accepted.
- GitHub synchronization and publication have not been exercised against the live GitHub API.
- No real legacy scope has been used for dogfood, cutover or rollback.
- Mermaid escaping and deterministic grammar are tested, but browser rendering has not been exercised.

M1 and M2 behavior is implemented and locally exercised. M3 contains runtime, GitHub and importer paths, but live interoperability remains an acceptance gate. M4 has a synthetic-scope proof only. Production replacement remains a No-Go until the external gates pass.
