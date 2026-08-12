# wr

`wr` is a local relationship ledger for tasks, CLI sessions, session runs, executions, Git worktrees, branches, pull requests, and workpads. It does not start workflows or manage task dependencies.

## Requirements

- Bun
- Git
- `gh` for pull request registration
- Claude Code or Codex

## Development

```bash
bun install
bun run format:check
bun run lint
bun test
bun run typecheck
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

The hooks only register their stdin JSON in SQLite and never access the network. SessionStart events outside enabled repositories are ignored. SessionEnd still closes an existing registered run after the session moves outside its enabled repository. After adding the Codex hooks, open `/hooks`, review them, and mark them as trusted.

## Commands

```bash
wr config enable .

wr task start MAL-123 --title "Task title" --worktree .
wr task done MAL-123

wr pr add 123 --task MAL-123
wr pr add 124 --task MAL-123 --parent 123
wr link workpad ./workpad.md --task MAL-123

wr show
wr show --task MAL-123
wr show --worktree .
wr sessions
```

Commands that omit a task infer it only when the current checkout has exactly one active task. Use `--session codex:<id>` or `--session claude:<id>` when the current session cannot be discovered automatically.

`wr task done` closes executions for the selected task only. Executions in the current CLI session become `finished`; executions in other sessions become `abandoned`. Executions for other tasks in the same session remain untouched.
