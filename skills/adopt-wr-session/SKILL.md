---
name: adopt-wr-session
description: Reconstruct the wr relationship ledger for an already-running Codex, Claude, or Devin session from the agent's remembered context. Use when hooks were installed after a session started, when an existing agent must register all remembered tasks, worktrees, executions, pull requests, stack parents, and workpads, or when handing off a session that was not tracked from startup.
---

# Adopt an existing wr session

Use this skill only when adopting an already-running session. It is separate from routine `wr` operations because it requires a complete memory-based inventory and a final reconciliation.

## Reconstruct the inventory

Run the adoption from inside the session being registered. Do not register another live agent's session from a coordinator session.

Before changing the ledger, enumerate every item the current agent remembers for this session:

- Linear issue identifiers and titles
- worktree paths and branches
- pull request numbers, repositories, and stack parents
- workpad paths and other known task links

Do not stop after the first item. Do not invent an item that is not remembered. If an item is uncertain, put it in the unresolved list instead of guessing.

## Register the session context

Confirm repository opt-in first:

```bash
wr config list
```

If the repository is not enabled, report that fact and stop. Do not enable it implicitly.

Register the existing session and current checkout:

```bash
# Codex resolves CODEX_THREAD_ID automatically.
wr show

# Claude Code exposes the current session ID to Bash subprocesses.
wr show --session "${CLAUDE_CODE_SESSION_ID}"
```

`wr show` creates or repairs the CLI session, SessionRun, and current Git checkout. The value passed to `--session` is the raw Codex thread ID or Claude session ID when that CLI can be inferred. For Devin, pass the explicit `devin:<session-id>` form.

If `CLAUDE_CODE_SESSION_ID` is empty, or automatic discovery conflicts with the explicit ID, stop and report the condition. Do not inspect transcript storage or force an identity.

## Register every remembered relationship

For every remembered task/worktree pair, create the execution in the same session:

```bash
wr task start MAL-123 --worktree .
wr task start MAL-124 --worktree ../worktrees/mal-124 --session "${CLAUDE_CODE_SESSION_ID}"
```

Register stack parents before children, and register every remembered pull request:

```bash
wr pr add 123 --task MAL-123 --session "${CLAUDE_CODE_SESSION_ID}"
wr pr add 124 --task MAL-123 --parent 123 --session "${CLAUDE_CODE_SESSION_ID}"
```

Register every remembered workpad or other known link:

```bash
wr link workpad add ./workpad.md --task MAL-123 --session "${CLAUDE_CODE_SESSION_ID}"
```

If the current branch has an open pull request and the task is known, explicitly refresh GitHub metadata after task registration:

```bash
wr sync --session "${CLAUDE_CODE_SESSION_ID}"
```

`wr sync` is explicit and networked. Do not put it in hooks. If GitHub lookup fails, report the failure and preserve the rest of the registrations.

## Reconcile and report

Read back the reconstructed ledger:

```bash
wr show --session "${CLAUDE_CODE_SESSION_ID}"
wr task list --global --session "${CLAUDE_CODE_SESSION_ID}"
wr execution list --global --session "${CLAUDE_CODE_SESSION_ID}"
wr pr list --global --session "${CLAUDE_CODE_SESSION_ID}"
wr link list --global --session "${CLAUDE_CODE_SESSION_ID}"
```

Compare the output with the inventory. Report:

1. every remembered item;
2. every registration performed;
3. every item still unresolved or unregistered, with the reason.

The target state is the same set of relationships that would have been recorded if the session had been registered at startup. Unknown facts remain unknown; never infer a task, PR, stack parent, worktree, or link from memory gaps.
