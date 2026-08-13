# wr

`wr` is a local relationship ledger for tasks, CLI sessions, session runs, executions, Git worktrees, branches, pull requests, and workpads. It does not start workflows or manage task dependencies.

## Requirements

- Bun
- Git
- `gh` for pull request registration and synchronization
- Optional: `jq` for `--jq` output filtering
- Optional: `it2` for iTerm2 pane liveness and focus
- Claude Code or Codex

## Development

```bash
bun install
bun run format:check
bun run lint
bun run typecheck
bun run knip
bun run test
bun src/cli.ts --help
```

## Compile

Create a standalone executable before installing `wr` on `PATH`:

```bash
bun run compile
install -m 755 dist/wr "$HOME/.local/bin/wr"
```

Tagged releases publish macOS binaries and update `mkusaka/homebrew-tap` automatically. Install a release with:

```bash
brew install mkusaka/tap/wr
```

The database is created at `$XDG_DATA_HOME/wr/wr.db`. When `XDG_DATA_HOME` is unset, `wr` uses `$HOME/.local/share/wr/wr.db`.

## Repository opt-in

`wr` does not register or modify relationships for a repository until it is enabled explicitly:

```bash
wr config enable .
wr config list
wr config disable .
```

The configuration is stored at `$XDG_CONFIG_HOME/wr/config.json`, or `$HOME/.config/wr/config.json` when `XDG_CONFIG_HOME` is unset. Repository paths are normalized to their main worktree, so enabling any linked worktree enables the entire repository. Disabling a repository prevents new writes and does not delete existing ledger records.

## Hooks

Add the following command hooks to the Claude Code user settings and Codex user hooks without replacing existing entries.

| Client      | SessionStart                                              | SessionEnd                                              |
| ----------- | --------------------------------------------------------- | ------------------------------------------------------- |
| Claude Code | `$HOME/.local/bin/wr internal session-event --cli claude` | `$HOME/.local/bin/wr internal session-end --cli claude` |
| Codex       | `$HOME/.local/bin/wr internal session-event --cli codex`  | `$HOME/.local/bin/wr internal session-end --cli codex`  |

The hooks only register their stdin JSON in SQLite and never access the network. SessionStart associates the new run with its starting Git checkout. SessionStart events outside enabled repositories are ignored. SessionEnd still closes an existing registered run after the session moves outside its enabled repository. After adding the Codex hooks, open `/hooks`, review them, and mark them as trusted.

## Commands

```bash
wr config enable .

wr task add MAL-122 --title "Queued task"
wr task start MAL-123 --title "Task title" --worktree .
wr task done MAL-123
wr task cancel MAL-123

wr pr add 122
wr pr add 123 --task MAL-123
wr pr add 124 --task MAL-123 --parent 123
wr pr remove 123 --task MAL-123
wr sync
wr link workpad add ./workpad.md
wr link workpad add MOQ-1291
wr link workpad add ./workpad.md --task MAL-123
wr link workpad remove MOQ-1291

wr show
wr show --json
wr ui
wr doctor
wr show --task MAL-123
wr show --worktree .
wr task list
wr task list --global --status active
wr task list --session <session-id>
wr session list --task MAL-123
wr run list --pr 123
wr checkout list --session <session-id>
wr execution list --branch feature/foo
wr link list --pr 123
wr pr list
wr repo list
wr repo list --global --status active
wr branch list --task MAL-123
wr terminal list --task MAL-123
wr run focus <session-id>
wr terminal focus <iterm-session-id>

wr task list --json linearIssueId,status,title
wr task list --json linearIssueId,status --jq '.[] | select(.status == "active")'
wr task list --json
wr task list --limit 20
```

`wr task done` and `wr task cancel` infer an omitted task only when the current checkout has exactly one active task. Artifact commands never infer task relationships. Use `--session <id>` when the current session cannot be discovered automatically. The ID must already be registered when the CLI type cannot be inferred from the environment.

`wr task add` registers an unstarted task with `open` status without creating a session, checkout, or execution relationship. Repeating it preserves the current status and updates the title only when `--title` is provided. `wr task start` changes an open task to `active`.

`wr pr add` registers a task relationship only when `--task` is provided. The command always records the current session run and checkout independently of the optional task relationship.

`wr link workpad add` accepts an existing path or an identifier such as a task ID. Existing paths are normalized before storage. It always associates the workpad with the current checkout and registers a task relationship only when `--task` is provided. `wr link workpad remove` applies the same normalization and explicit task rule and removes the matching relationship from the current checkout.

`wr task done` closes executions for the selected task only. Executions in the current CLI session become `finished`; executions in other sessions become `abandoned`. Executions for other tasks in the same session remain untouched.

`wr task cancel` marks the selected task as `cancelled` and abandons all of its active executions. It is idempotent and does not alter executions for other tasks. `wr link workpad remove` removes only the ledger record; it does not delete the workpad file.

Resource commands are scoped to the current repository when run inside a Git checkout and use the global ledger otherwise. Pass `--global` to override repository scoping or `--repo PATH` to select a repository explicitly. All resource commands accept relationship filters: `--task`, `--session`, `--run`, `--checkout`, `--execution`, `--link`, `--terminal`, `--worktree`, `--branch`, and `--pr`. `--session` accepts a Codex thread ID or Claude session ID without a CLI prefix. If the same external ID exists for both clients, the command reports ambiguity. `--task` accepts the Linear issue identifier stored in the ledger. Use `--limit NUMBER` to bound the filtered and ordered results. Tasks are ordered by `updated_at` descending.

`wr repo list` groups stored checkouts by repository and shows worktree, task, and active execution counts. Its `active` status means that the repository has at least one active execution; otherwise it is `inactive`. The `enabled` field reflects the current opt-in configuration.

Use `--json FIELD,...` to select machine-readable fields and `--jq EXPRESSION` to filter that JSON with the installed `jq` command. Pass `--json` without a value to list the available fields for a resource.

`wr sync` checks the current checkout and every checkout with an active execution in the current CLI session. It uses `gh` to find one open pull request for each checked-out branch and records the discovering session run and checkout without creating task relationships. GitHub lookup failures stop the command before any database writes.

`wr session list` lists stable CLI sessions such as `codex:<thread-id>` and `claude:<session-id>`. `wr run list` lists their individual SessionRuns. Relationship filters traverse stored Run-to-Checkout and Execution relationships, so no GitHub or Linear network lookup is performed.

Session runs and Git checkouts are related independently of tasks. SessionStart records the starting checkout, and later `wr` commands record the checkout where they run. `wr task start --worktree PATH` also records the selected checkout. An Execution is created only by `wr task start`; registering a run never creates one implicitly.

When `it2` is available, `wr run list` marks each pane as `live` or `closed`. Use `wr run focus CLI:ID` or `wr run focus RUN_ID` to focus its active iTerm2 pane. Without `it2`, pane status is `unknown`.

The previous plural resource commands, `wr link workpad REF`, and `wr link remove workpad REF` remain available temporarily. Migrate callers to `wr <resource> list` and `wr link workpad add|remove`; the compatibility commands will be removed later.

`wr ui` lists active iTerm2-backed runs across the ledger. Type to filter by task ID, repository, branch, pull request number or URL, and session ID. Use the arrow keys to select a row and Enter to focus it. The list is loaded once at startup.

`wr doctor` performs read-only database integrity and foreign-key checks, reports repository opt-in and current session registration, checks optional command availability, and verifies that both lifecycle hook commands appear in the Claude Code and Codex user hook files.
