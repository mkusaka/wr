---
name: wr
description: Use the wr CLI relationship ledger to register and inspect tasks, CLI sessions, Git checkouts, pull requests, workpads, conversation links, and device metadata. Use when working with this repository's wr CLI or Web UI; keep remote D1 and Wrangler migration procedures in the repo-local ops-wr skill.
---

# wr CLI

Use `wr` as a relationship ledger. It records context and relationships; it does not orchestrate work or infer dependencies.

## Configure and inspect context

Check repository opt-in before recording work:

```bash
wr config list
wr config enable .
wr server open
```

Inspect the current context and diagnose ambiguous relationships:

```bash
wr show
wr show --json
wr doctor
wr task list --status active
```

`wr show --json` summarizes the current task, execution, pull requests, and links. Use `wr show --task ISSUE` or `wr show --worktree .` for reverse lookup.

## Track work and local context

Use the resource matching the relationship you need:

```bash
wr task add ISSUE --title "Queued task"
wr task start ISSUE --title "Task title" --worktree .
wr task done ISSUE

wr session list --task ISSUE
wr session tree --session claude:<session-id>
wr checkout list --session SESSION_ID
wr execution list --branch BRANCH
wr run list
wr run sync
wr run focus SESSION_RUN_ID
wr terminal list --task ISSUE
```

Use the raw CLI session ID with `--session` when the current session cannot be discovered. For Devin, use `devin:<session-id>` when the CLI environment is unavailable.

## Preserve session lineage

Hooks register every distinct Pi, Codex, Claude, and Devin session ID that reaches a child process. They do not infer a direct parent from those inherited IDs.

When launching one agent from another and the current session identity is known, pass it to that one child launch as `WR_PARENT_CLI_SESSION=<cli>:<id>`. For example, a Claude shell launching a child agent may use `WR_PARENT_CLI_SESSION="claude:${CLAUDE_CODE_SESSION_ID}"`. Leave the variable unset when the parent is unknown; never manufacture a value from an ambiguous inherited environment.

`wr session tree --session claude:<session-id>` renders the root-to-target ancestor path and the target's descendants. Add `--json` for `{ ancestors, session: { children } }`.

Register GitHub and workpad relationships with their dedicated resources:

```bash
wr pr add NUMBER --task ISSUE
wr pr sync
wr link workpad add ./workpad.md --task ISSUE
wr link workpad remove ./workpad.md --task ISSUE
wr branch list --task ISSUE
```

`wr link` stores workpad links. Do not use it for arbitrary URLs or Slack threads.

## Link a Slack conversation to a CLI session

Associate a Slack thread with the current CLI session and checkout:

```bash
wr conversation add "https://workspace.slack.com/archives/C0123456789/p1234567890123456"
wr conversation add "https://workspace.slack.com/archives/C0123456789/p1234567890123456?thread_ts=1234567890.123456" --session SESSION_ID
wr conversation remove "https://workspace.slack.com/archives/C0123456789/p1234567890123456" --session SESSION_ID
```

Accepted links are Slack archive permalinks on a `*.slack.com` workspace. A root message uses the `p` timestamp; a reply may include `thread_ts`. The CLI sends the URL and current context to the Worker, which stores the device, CLI session, optional checkout, provider, and normalized conversation key. Use `--session` when the link belongs to a session other than the discovered current session.

The operation is idempotent for the same device, session, provider, and Slack thread. Removing a link is scoped to the selected device and CLI session.

## Web UI relationships

The Web UI exposes conversation links alongside runs, tasks, and pull requests. Search matches the Slack URL, workspace or channel identifier, device, repository, and worktree. Conversation links appear in the session/task relationship cards and open the Slack URL in a new tab.

Pull request cards include the associated device name, and branch names are copyable. Keep those relationships visible when changing the corresponding API or UI payloads.

## Change boundaries

- Keep the Worker API and schema changes in `worker/` and `worker/schema.ts`.
- Keep CLI parsing and local context discovery in `src/`.
- Keep Web UI rendering and filtering in `web/`.
- Keep generated SQL and Drizzle metadata under `migrations/`.
- Keep remote D1 history inspection, Wrangler authentication, and migration application in `.agents/skills/ops-wr/SKILL.md`.

When changing a relationship, inspect its CLI command, API endpoint, persistence schema, Web UI projection, and focused tests together.
