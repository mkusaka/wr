---
name: operate-wr
description: Operate the wr relationship-ledger CLI to register and inspect tasks, CLI sessions, Git worktrees, pull requests, and workpads. Use when starting or completing tracked work, attaching PRs or workpads, identifying the task for a checkout or session, listing active session runs, or diagnosing ambiguous task context.
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
wr sessions
```

If session discovery fails, pass `--session codex:<thread-id>` or `--session claude:<session-id>`. Do not override a discovered session with a conflicting explicit value.

## Track task work

Start an execution after selecting the task and checkout:

```bash
wr task start MAL-123 --title "Task title" --worktree .
```

Complete only the selected task:

```bash
wr task done MAL-123
```

Starting a completed task reopens it and reports that change. Completing a task finishes its execution in the current CLI session and abandons active executions for the same task in other sessions. It does not alter executions for other tasks.

## Attach artifacts

Register a GitHub pull request from its checkout. This command calls `gh` and writes nothing if GitHub lookup fails:

```bash
wr pr add 123 --task MAL-123
wr pr add 124 --task MAL-124 --parent 123
```

Register a workpad:

```bash
wr link workpad ./workpad.md --task MAL-123
```

Omit `--task` only when the current checkout has exactly one active task. If `wr` reports ambiguity, inspect the context and provide `--task`; never guess.

## Preserve boundaries

- Do not edit the SQLite database directly.
- Do not call `wr internal` manually; session hooks own those commands.
- Do not enable repositories speculatively.
- Do not infer task dependencies, start workflows, or synchronize GitHub state automatically.
- Report ambiguity or command failure instead of creating speculative relationships.
