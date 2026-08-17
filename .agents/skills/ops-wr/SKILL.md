---
name: ops-wr
description: Operate the wr relationship-ledger CLI and the paired Linear/Jira task workflow to register and inspect tasks, CLI sessions, Git worktrees, pull requests, and workpads. Use for routine task tracking, attaching or removing artifacts, listing related records, synchronizing explicitly, focusing an iTerm2 pane, or diagnosing ambiguous task context.
---

# Operate wr

Use `wr` only as a relationship ledger. Do not treat it as an orchestrator or dependency manager.

## Check repository opt-in

Inspect enabled repositories before recording work:

```bash
wr config list
```

Enable or disable the current repository only when the user has requested that tracking state:

```bash
wr config enable .
wr config disable .
wr server open
```

If the repository is not enabled and the user has not authorized opt-in, report that condition instead of enabling it implicitly. Enabling any linked worktree enables the whole repository.

## Inspect context

Run `wr show` to inspect the current session and checkout. Use an explicit reverse lookup when the current context is unavailable:

```bash
wr show --task MAL-123
wr show --worktree .
wr show --json
wr doctor
wr task list
wr pr list
wr repo list
wr run list
wr run sync
wr run list --pr 123
wr session list --task MAL-123
wr checkout list --session <session-id>
wr execution list --branch feature/foo
wr link list --pr 123
wr branch list --task MAL-123
wr terminal list --task MAL-123
wr run focus <session-id>
```

`wr show --json` は、関連 task と execution、PR、link をまとめた JSON を返す。
resource コマンドの `--json FIELD,...` や `--jq FILTER` とは異なり、フィールド指定は受け取らない。

Worktree の作成が必要な場合は `wt add` を使う。ヘルプは `wt help` で確認し、
対応していない `wt add --help` は使わない。

Use `wr --help`, `wr help RESOURCE`, or `wr RESOURCE ACTION --help` for command discovery. The
`link` resource currently supports only workpads; it does not store arbitrary
URLs such as Confluence links:

```bash
wr link workpad add ./workpad.md --task MAL-123
```

Resource list commands use the current repository inside Git and the global ledger outside Git. Use `--global` explicitly when a repository-local command needs global results. Filter tasks with `wr task list --status active`.

Use `wr task list`, `wr session list`, `wr run list`, `wr checkout list`, `wr execution list`, `wr link list`, `wr pr list`, `wr branch list`, `wr terminal list`, and `wr repo list` to choose the output resource. Filter any resource by a stored relationship with `--task`, `--session`, `--run`, `--checkout`, `--execution`, `--link`, `--terminal`, `--repo`, `--worktree`, `--branch`, or `--pr`. Pass the raw Codex thread ID, Claude session ID, or Devin session ID to `--session`, without a CLI prefix when the corresponding CLI environment is available. Otherwise pass the explicit `devin:<session-id>` form for Devin. `--task` accepts the Linear issue identifier. Use `--limit NUMBER` to bound ordered results, `--json FIELD,...` for structured output, and `--jq EXPRESSION` only when the installed `jq` command is available. Pass bare `--json` to discover fields.

`wr session list` refers to stable CLI sessions. `wr run list` refers to individual SessionRuns and `wr run focus` can focus a related iTerm2 pane. The human-readable session field uses `claude:<session-id>`, `codex:<thread-id>`, or `devin:<session-id>`.

Use `wr run sync` on each Device to end active runs whose recorded iTerm2 sessions no longer exist. It leaves runs without a terminal ID unchanged.

The previous plural resource commands, `wr link workpad REF`, and `wr link remove workpad REF` are temporary compatibility paths. Do not use them in new instructions; migrate existing callers because they will be removed later.

If session discovery fails, pass the existing session ID with `--session`. Do not override a discovered session with a conflicting explicit value. Mutating commands automatically register a discovered session and create an implicit session run and checkout when the context is not registered yet. Commands that name a task also register that task when the operation establishes or updates it, such as `task done`, `task cancel`, `pr add --task`, and `link workpad add --task`. Use `$adopt-wr-session` for full reconstruction of an already-running session with multiple remembered relationships.

## Track task work

For substantive work, register the task in both systems before starting execution:

1. Find or create the corresponding Linear issue using the Linear skill.
2. Find or create the corresponding Jira issue using the available Jira/Atlassian skill. Reuse an existing Jira issue when one already represents the same work; do not create duplicates.
3. Record both issue keys in the task's workpad or the user-facing handoff. `wr` stores the Linear issue identifier as its task key and has no Jira field; do not invent a `wr` option for Jira.
4. Start and manage the `wr` relationship from the Linear issue key.

Start an execution after selecting the task and checkout:

```bash
wr task add MAL-122 --title "Queued task"
wr task start MAL-123 --title "Task title" --worktree .
```

Use `wr task add` to register unstarted work with `open` status. It does not require a CLI session and does not create an execution. Repeating it preserves the current status and only updates an explicitly provided title.

Complete only the selected task. If the named task is not registered, `wr` registers it before completing it:

```bash
wr task done MAL-123
```

Cancel a task only when work on it should stop, abandoning its active executions:

```bash
wr task cancel MAL-123
```

When completing or cancelling work, update both the Linear and Jira issues to the corresponding final state. If the Jira connector or project mapping is unavailable, stop before claiming task registration is complete and report the missing Jira registration.

Starting a completed task reopens it and reports that change. Completing a task finishes its execution in the current CLI session and abandons active executions for the same task in other sessions. It does not alter executions for other tasks.

## Attach artifacts

Register a GitHub pull request from its checkout. This command calls `gh`, automatically registers a task named by `--task` when needed, and writes nothing if GitHub lookup fails:

```bash
wr pr add 122
wr pr add 123 --task MAL-123
wr pr add 124 --task MAL-124 --parent 123
wr pr remove 123 --task MAL-123
wr pr sync
wr pr sync --all
wr sync
```

`wr pr add` creates a task relationship only when `--task` is provided. It always records the current session run and checkout. Run `wr pr sync` to refresh GitHub state for registered pull requests without requiring a current session or repository. It checks unknown and open pull requests by default; `--all` also checks closed and merged pull requests. After creating, updating, or rebasing pull requests, run `wr sync` before the next user handoff or final report. That command records session run and checkout relationships without inferring tasks.

Register a workpad. A task named by `--task` is registered when needed:

```bash
wr link workpad add ./workpad.md
wr link workpad add MOQ-1291
wr link workpad add ./workpad.md --task MAL-123
wr link workpad remove MOQ-1291
wr link workpad remove ./workpad.md --task MAL-123
```

Workpad references may be existing paths or identifiers such as task IDs. Existing paths are normalized. Workpads are always associated with the current checkout and create a task relationship only when `--task` is provided.

## Preserve boundaries

- Do not edit the relationship ledger storage directly. Use the `wr` CLI or Worker API.
- Do not call `wr internal` manually; session hooks own those commands.
- Do not enable repositories speculatively.
- Do not infer task dependencies or start workflows.
- Do not place `wr sync` in lifecycle hooks; invoke it after explicit GitHub work or before handoff.
- Report ambiguity or command failure instead of creating speculative relationships.

## D1 Migrations

This repo uses Drizzle's `__drizzle_migrations` history table, which is separate from Wrangler's `d1_migrations` history table on the remote D1 database. If `bunx wrangler d1 migrations apply DB --remote` reports all historical migrations as pending, do not apply them to an existing remote DB that already has a `__drizzle_migrations` record. Applying them blindly can re-run already-applied schema changes.

Inspect both histories before deciding:

```bash
bunx wrangler d1 execute DB --remote --command "SELECT * FROM sqlite_schema WHERE name IN ('__drizzle_migrations','d1_migrations')"
bunx wrangler d1 execute DB --remote --command "SELECT * FROM __drizzle_migrations ORDER BY created_at"
bunx wrangler d1 execute DB --remote --command "SELECT * FROM d1_migrations ORDER BY applied_at"
```

For this repository's Drizzle remote config, obtain the Wrangler values without printing the token:

```bash
env \
  CLOUDFLARE_ACCOUNT_ID="$(bunx wrangler whoami --json | jq -r '.accounts[0].id')" \
  CLOUDFLARE_DATABASE_ID="$(bunx wrangler d1 list --json | jq -r '.[] | select(.name == "wr") | .uuid')" \
  CLOUDFLARE_D1_TOKEN="$(bunx wrangler auth token --json | jq -r '.token')" \
  bun run db:migrate
```

The JSON form of `wrangler auth token` prevents the Wrangler banner from being included in `CLOUDFLARE_D1_TOKEN`. Keep the token in command substitution or an environment variable and do not print it.
