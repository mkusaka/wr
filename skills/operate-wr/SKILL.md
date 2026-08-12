---
name: operate-wr
description: Operate the wr relationship-ledger CLI to register and inspect tasks, CLI sessions, Git worktrees, pull requests, and workpads. Use when starting or completing tracked work, attaching, removing, listing, or synchronizing PRs, identifying tasks by repository, listing active session runs, focusing an iTerm2 pane, adopting sessions that were already running before wr hooks were installed, or diagnosing ambiguous task context.
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
wr tasks
wr prs
wr runs
wr runs --pr 123
wr sessions --task MAL-123
wr checkouts --session codex:<thread-id>
wr executions --branch feature/foo
wr links --pr 123
wr branches --task MAL-123
wr terminals --task MAL-123
wr runs focus codex:<thread-id>
```

Resource commands use the current repository inside Git and the global ledger outside Git. Use `--global` explicitly when a repository-local command needs global results. Filter tasks with `wr tasks --status active`.

Use `wr tasks`, `wr sessions`, `wr runs`, `wr checkouts`, `wr executions`, `wr links`, `wr prs`, `wr branches`, and `wr terminals` to choose the output resource. Filter any resource by a stored relationship with `--task`, `--session`, `--run`, `--checkout`, `--execution`, `--link`, `--terminal`, `--repo`, `--worktree`, `--branch`, or `--pr`. `--task` accepts the Linear issue identifier. Use `--json FIELD,...` for structured output and `--jq EXPRESSION` only when the installed `jq` command is available. Pass bare `--json` to discover fields.

`wr sessions` refers to stable CLI sessions. `wr runs` refers to individual SessionRuns and can focus a related iTerm2 pane. Claude sessions use `claude:<session-id>` and Codex sessions use `codex:<thread-id>`.

If session discovery fails, pass `--session codex:<thread-id>` or `--session claude:<session-id>`. Do not override a discovered session with a conflicting explicit value.

## Adopt a session opened before wr

Run adoption from inside each session being registered. Do not register another live agent's session from a coordinator session.

First confirm that the repository is already enabled. If it is not enabled, report that condition instead of changing the configuration. Then register the session and its current checkout:

```bash
# Codex resolves CODEX_THREAD_ID automatically.
wr show

# Claude Code exposes the current ID to Bash tool subprocesses.
wr show --session "claude:${CLAUDE_CODE_SESSION_ID}"
```

If the task is known, attach it in the same session instead of guessing from other ledger rows:

```bash
wr task start MAL-123 --worktree .
wr task start MAL-123 --worktree . --session "claude:${CLAUDE_CODE_SESSION_ID}"
```

Finish with `wr show`, passing the same explicit Claude session when needed. This first authoritative command creates the missing CLI session, SessionRun, and checkout rows. If `CLAUDE_CODE_SESSION_ID` is empty, or session discovery conflicts with `--session`, stop and report the condition. Do not inspect transcript storage or force an identity.

When assigning this migration to an existing agent, provide the known task ID or state that it is unknown. Ask the agent to use this skill, register only its own current session, attach the task only when supplied, verify with `wr show`, and make no source-code changes.

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
wr pr remove 123 --task MAL-123
wr sync
```

After creating, updating, or rebasing pull requests, run `wr sync` before the next user handoff or final report. It checks the current checkout and active checkouts in the current CLI session. If it reports multiple active tasks, use `wr pr add --task` explicitly instead of guessing.

Register a workpad:

```bash
wr link workpad ./workpad.md --task MAL-123
```

Omit `--task` only when the current checkout has exactly one active task. If `wr` reports ambiguity, inspect the context and provide `--task`; never guess.

## Preserve boundaries

- Do not edit the SQLite database directly.
- Do not call `wr internal` manually; session hooks own those commands.
- Do not enable repositories speculatively.
- Do not infer task dependencies or start workflows.
- Do not place `wr sync` in lifecycle hooks; invoke it after explicit GitHub work or before handoff.
- Report ambiguity or command failure instead of creating speculative relationships.
