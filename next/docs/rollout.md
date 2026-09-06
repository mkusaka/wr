# Rollout and external verification

## Before real use

1. Run `bun ci` and `bun run verify` in `next/`.
2. Run `bun run test:workerd`. This is local only.
3. Select a temporary repository/worktree and an explicitly permitted real runtime. Run the opt-in live check, recording actual CLI version, authentication mode and hooks observed.
4. Validate GitHub read synchronization on an explicitly selected PR. Then exercise creation/retry on a disposable approved repository; never use production PRs to test failure injection.
5. Configure a new remote Worker and secret/member/Access settings only with operational approval. Test login expiration and outbox recovery; no interactive OAuth refresh is currently implemented.
6. Dry-run import a selected legacy scope. Resolve every unsupported diagnostic; do not remove evidence fields to get a green import.
7. Compare the imported scope against its actual legacy readiness rules and artifacts. The bundled pure reference tests are not proof of parity for domain-specific policy.
8. Use a small explicitly selected scope as a new-authority dogfood, then verify rollback before considering a broader cutover.

## Rollback

Stop or isolate all participating writers first. `rollback SOURCE --confirm W` changes authority mode to legacy and makes the imported scope read-only in the successor. It keeps new executions/results/artifacts/acceptances. It does not delete old files, auto-restart old agents, reverse code changes, or rewrite old Markdown. Reconcile actual commits and work progress before resuming old coordination.

If a process is unobservable, do not treat heartbeat expiry as stopped. Preserve the worktree. `recover EXEC --stopped --reason ...` is operator confirmation, not automated process termination.

## Evidence required for Go

- New authority authenticates genuine users and denies wrong workspace/device/context.
- Actual runtime start, context restoration, session resume and optional native rollover are observed, not simulated.
- Actual Git/PR/review/CI all refer to exact current versions, with no false publisher claims.
- Actual selected legacy scope has documented zero-difference comparison or explicitly approved semantic changes.
- A real task is completed, and rollback is rehearsed without duplicate writers or lost progress.
- Expired credentials, pending observations, unknown processes and unsupported imported predicates are actionable in status/doctor.

The implementation here is **No-Go for replacing production wr until those external checks pass**. Final rename, old DB migration/deletion, hook removal, merge, tag/release and Homebrew changes are separate actions.
