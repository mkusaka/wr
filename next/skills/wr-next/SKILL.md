---
name: wr-next
description: Coordinate work, runs, and provenance with the wr-next CLI in repositories that opted in. Use for status/plan/claim/report/done flows, verification checks, delegated read-only children, Git provenance, and GitHub PR synchronization in initialized checkouts. Do not use for repositories without .wr/config.json.
---

# Operate wr-next

`wr-next` is a work ledger, not a session log. Check repository opt-in before recording anything:

```sh
wr-next status
wr-next doctor
```

If `.wr/config.json` is absent, wr-next is not initialized here; report that instead of running `init` on your own. Initialization is explicit operator opt-in (`wr-next init` / `init --agent-managed`).

## Agent-managed coordination (plain-started sessions)

A session started normally inside an initialized repository becomes a scoped Coordinator. It plans work and claims one leaf at a time:

```sh
wr-next status                        # context, bound work, ready candidates
wr-next plan --changes '[{"type":"work.create","title":"Implement X"}]'
wr-next next --claim                  # atomically claim one ready leaf
wr-next report --decision "..." --reason "..."   # record a decision
wr-next report --progress "..."       # heartbeat-style progress note
wr-next report --blocked "..."        # surface a blocker instead of stalling
wr-next done --summary "..."          # submit the result; never silently complete
wr-next yield --reason "..."          # release the claim at the next tool boundary
```

Rules that matter:

- `done` submits a result for acceptance; it is not self-approved completion.
- Plan changes are typed (`work.create`, `work.update`, `dependency.add`, `dependency.remove`, `lane.set`, `work.cancel`, `work.reopen`). Conflicting plans are rejected, never rebased.
- Keep tool calls on the claimed Work. A descendant process cannot inherit a Coordinator grant; use `wr-next delegate` for native children.

## Explicit operator-selected work

```sh
wr-next add "Task title" [--under W] [--needs W1,W2] [--checks tests]
wr-next run W -- claude|codex|omp|devin   # claims, reserves, injects context, spawns
wr-next run --next -- claude              # claim next ready work and run
wr-next verify W --check tests -- bun test
```

`run` infers the runtime from the executable basename; `--runtime generic` runs any command. `devin` is wrapper-only: no native hooks, just process/Git/PR capture.

## Native children

```sh
wr-next delegate REF --read-only    # returns a spawnDirective
```

Put the returned `spawnDirective` on the first line of the delegated child prompt. Unmarked, nested, writable, or background native spawns are denied rather than attributed.

## Provenance and PRs

```sh
wr-next provenance sync
wr-next provenance check origin/main..HEAD
wr-next explain commit HEAD
wr-next pr create W --title "..." --body-file pr.md --base main
wr-next pr sync NUMBER --repo OWNER/REPO
wr-next graph [W] | wr-next export [W]
```

## Boundaries

- Never invent Work/Run/Execution IDs, tokens, or session IDs; read them from `wr-next status` or command receipts.
- Do not run `init`, `integrations`, `management`, or `hooks` commands from inside a managed session; installation is operator-owned.
- Remote authority requires `wr-next connect` with provisioned credentials; a connection failure never falls back to a different authority silently.
