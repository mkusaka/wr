---
name: ops-wr
description: Operate the wr relationship-ledger CLI to register and inspect tasks, CLI sessions, Git worktrees, pull requests, and workpads. Use for routine task tracking, attaching or removing artifacts, listing related records, synchronizing explicitly, focusing an iTerm2 pane, or diagnosing ambiguous task context.
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
