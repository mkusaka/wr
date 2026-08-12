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
```

If the repository is not enabled and the user has not authorized opt-in, report that condition instead of enabling it implicitly. Enabling any linked worktree enables the whole repository.

## Inspect context

Run `wr show` to inspect the current session and checkout. Use an explicit reverse lookup when the current context is unavailable:

```bash
wr show --task MAL-123
wr show --worktree .
wr doctor
wr tasks
wr prs
wr repos
wr runs
wr runs --pr 123
wr sessions --task MAL-123
wr checkouts --session <session-id>
wr executions --branch feature/foo
wr links --pr 123
wr branches --task MAL-123
wr terminals --task MAL-123
wr runs focus <session-id>
```

Use `wr --help` for command discovery. There is no `wr help` subcommand. The
`link` command currently supports only workpads; it does not store arbitrary
URLs such as Confluence links:

```bash
wr link workpad ./workpad.md --task MAL-123
```

Resource commands use the current repository inside Git and the global ledger outside Git. Use `--global` explicitly when a repository-local command needs global results. Filter tasks with `wr tasks --status active`.

Use `wr tasks`, `wr sessions`, `wr runs`, `wr checkouts`, `wr executions`, `wr links`, `wr prs`, `wr branches`, `wr terminals`, and `wr repos` to choose the output resource. Filter any resource by a stored relationship with `--task`, `--session`, `--run`, `--checkout`, `--execution`, `--link`, `--terminal`, `--repo`, `--worktree`, `--branch`, or `--pr`. Pass the raw Codex thread ID or Claude session ID to `--session`, without a CLI prefix. `--task` accepts the Linear issue identifier. Use `--limit NUMBER` to bound ordered results, `--json FIELD,...` for structured output, and `--jq EXPRESSION` only when the installed `jq` command is available. Pass bare `--json` to discover fields.

`wr sessions` refers to stable CLI sessions. `wr runs` refers to individual SessionRuns and can focus a related iTerm2 pane. The human-readable session field uses `claude:<session-id>` or `codex:<thread-id>`.

If session discovery fails, pass the existing session ID with `--session`. Do not override a discovered session with a conflicting explicit value. Use `$adopt-wr-session` for full reconstruction of an already-running session.

## Track task work

Start an execution after selecting the task and checkout:

```bash
wr task start MAL-123 --title "Task title" --worktree .
```

Complete only the selected task:

```bash
wr task done MAL-123
```

Cancel a task only when work on it should stop, abandoning its active executions:

```bash
wr task cancel MAL-123
```

Starting a completed task reopens it and reports that change. Completing a task finishes its execution in the current CLI session and abandons active executions for the same task in other sessions. It does not alter executions for other tasks.

## Attach artifacts

Register a GitHub pull request from its checkout. This command calls `gh` and writes nothing if GitHub lookup fails:

```bash
wr pr add 123 --task MAL-123
wr pr add 124 --task MAL-124 --parent 123
wr pr remove 123 --task MAL-123
wr sync
```

After creating, updating, or rebasing pull requests, run `wr sync` before the next user handoff or final report. It checks the current checkout and active checkouts in the current CLI session. If it reports multiple active tasks, use `wr pr add --task` explicitly instead of guessing.

Register a workpad:

```bash
wr link workpad ./workpad.md --task MAL-123
wr link remove workpad ./workpad.md --task MAL-123
```

Omit `--task` only when the current checkout has exactly one active task. If `wr` reports ambiguity, inspect the context and provide `--task`; never guess.

## Preserve boundaries

- Do not edit the SQLite database directly.
- Do not call `wr internal` manually; session hooks own those commands.
- Do not enable repositories speculatively.
- Do not infer task dependencies or start workflows.
- Do not place `wr sync` in lifecycle hooks; invoke it after explicit GitHub work or before handoff.
- Report ambiguity or command failure instead of creating speculative relationships.
