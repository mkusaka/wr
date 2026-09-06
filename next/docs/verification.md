# Verification record

## Executed after integration

- Bun 1.4.2, TypeScript 5.8.3, real local Git and Bun SQLite.
- `bun ci` completed without lockfile changes.
- `bun run verify` completed: formatting, strict type checking, safety/architecture lint, 223 tests, the minimal demo and the local integration proof.
- `bun run test:workerd` completed against real local workerd, a SQLite-backed Durable Object and the capability gateway.
- The existing wr CI-equivalent checks completed: format, lint, typecheck, knip, 140 tests, compile and `./dist/wr --help`.

The local integration proof uses real child processes, Git hooks/commits, SQLite and HTTP. Synthetic provider processes cover all three tool-binding contracts. Installed OMP 18.1.12 additionally completed an actual model-driven add/claim/done flow when the wr-next extension was loaded last.

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
- Permanent Claude/Codex/OMP repository integrations, ownership-aware reconciliation, worktree-local activation checks and fail-closed native guards.
- Canonical macOS worktree identity and Bun-on-macOS signal-name normalization.
- Private, repository-scoped Coordinator enrollment with no artificial root Execution or ambient operator fallback.
- Deterministic ready selection, atomic claim/retry, per-tool WorkDispatch fencing and sequential Work ownership within one Run.
- Coordinator revocation, process-stop evidence, environment reservation retention, inherited leaf checks and schema-version-3 migration.
- Plain Claude/Codex/OMP bootstrap contracts through generated permanent hooks or extension, including per-tool input binding and runtime-specific permission behavior.

## Remaining external acceptance gates

- Installed Codex 0.153.4 executed the generated SessionStart/SessionEnd hooks, but its model tool path could not run because the active account had reached its usage limit. Installed OMP 18.1.12 completed the full Coordinator flow; its ordinary user plugin stack also demonstrated the documented last-input-rewriter conflict and failed closed before claim.
- GitHub synchronization and publication have not been exercised against the live GitHub API.
- No real legacy scope has been used for dogfood, cutover or rollback.
- Mermaid escaping and deterministic grammar are tested, but browser rendering has not been exercised.

M1 and M2 behavior is implemented and locally exercised. M3 contains runtime, GitHub and importer paths, but live interoperability remains an acceptance gate. M4 has a synthetic-scope proof only. Production replacement remains a No-Go until the external gates pass.
