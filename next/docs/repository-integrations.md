# Repository runtime integrations

Status: implementation contract for the adjustment based on wr main `9954b20d36638e4944cd10bad34fc4dd1ca2c8fd`.
The existing Work/RuntimeAgent/Execution/Delegation model is retained. No authority schema migration is added by this change.

## Decision

Keep three separate responsibilities:

| Layer | Responsibility |
|---|---|
| `init` / integrations | Static instrumentation and safe ownership of its configuration entries |
| `run` / attach-capable harness | Dynamic Work/Run/Execution/capability binding |
| Runtime events | Observation, startup guidance, exact root tool dispatch, and supported child binding |

A static hook installer is not a work allocator, hook trust approver or completion evaluator. The Claude event adapter can dispatch one explicitly delegated read-only child because Claude exposes both child lifecycle IDs and `agent_id` on child tool events. `run` remains useful for process ownership, writable work, explicit binding and generic workers. Other native harnesses can use `NativeRuntimeBridge`; every agent is not required to be an independently wrapped subprocess.

## Normal interface

```sh
wr-next init --dry-run
wr-next init                           # detect existing runtime dirs / executable names
wr-next init --runtime claude,codex,omp
wr-next integrations                    # status, with activation limitations
wr-next integrations install codex
wr-next integrations sync
wr-next integrations uninstall codex

wr-next run W12 -- claude
wr-next run W13 -- codex
wr-next run W14 -- omp
wr-next run W15 -- devin               # wrapper-only, explicitly reported
```

`--runtime all` includes Devin as a declared wrapper-only integration, not a fictitious native hook file.
`init --no-git-hooks` only opts out of Git-hook installation; it does not remove existing Git hooks.
`integrations sync` reconciles runtime configuration. Existing `hooks status/install/uninstall` commands remain responsible for Git hooks.

Unmanaged sessions that happen to load these files are inert: no auto-claim, operator credential lookup, authority startup, or unrelated native-tool denial. A WorkItem cannot be inferred merely from its cwd or the existence of `.wr/config.json`.

## Files and ownership

```text
<worktree>/
  .wr/config.json                 Desired static integration selection
  .claude/settings.json           Only exact wr-next hook handlers are managed
  .codex/hooks.json               Only exact wr-next hook handlers are managed
  .omp/extensions/wr-next.ts       Owned standalone native extension

<worktree Git-private directory>/wr-next/integrations/
  manifest.json                   Installed handler/content ownership
  journal.json                    Incomplete multi-file change recovery, if present
  lock/                           Cooperative installer exclusion

<private wr-next state>/launches/<launch-id>/
  context.json                    Dynamic Work/Execution and scoped credentials
  runtime-connection.json         Legacy in-flight runs only; new runs use context.json
  integration-seen.json            Successful root-start receipt, not a native-child receipt
```

The desired configuration uses strict JSON to avoid introducing TOML/YAML parsers just to store four booleans. This is a deliberate implementation detail differing from the proposed `.wr/config.toml`; it does not change the static/dynamic separation.

```json
{
  "schemaVersion": 1,
  "gitHooks": true,
  "integrations": {
    "claude": true,
    "codex": true,
    "omp": true,
    "devin": false
  }
}
```

The static files contain no Work ID, Execution ID, token, server credential, per-device absolute path, or prompt. They can be reviewed and committed as project configuration. The private manifest is not required in a new clone: an exact shared projection can be adopted without duplicating it.

The fixed command is versioned and identifies its source/event, for example:

```sh
wr-next internal integration-event --source codex --adapter-version 1 --installation project --event SessionStart
```

Run binding is supplied privately via the environment. `WR_NEXT_RUNTIME_KIND` selects which wr-next source can act; it is routing metadata, not authentication. The authority still validates capabilities and Execution bindings.

## Runtime matrix

| Runtime | Static configuration | Implemented event path | Native child binding |
|---|---|---|---|
| Claude | `.claude/settings.json` | Plain Coordinator bootstrap, exact per-tool dispatch, compact window and advisory shutdown | One explicit foreground read-only Agent/Task; serial start correlation; nested/background/writable children denied |
| Codex | `.codex/hooks.json` | Plain Coordinator bootstrap and exact per-tool rewrite using the documented control marker | Guarded: lifecycle exposes `agent_id`, but child tool hooks do not expose a verified child actor |
| OMP | `.omp/extensions/wr-next.ts` | Plain Coordinator bootstrap, revised tool input, compact window and advisory shutdown | Guarded: the project extension has no stable spawn-to-child lifecycle identity |
| Devin | No native file generated | Generic process lifecycle and existing Git/PR provenance | Not claimed |
| Generic | No native file required | Explicit subprocess lifecycle | Not claimed |

These are implementation/contract-test statements, not live CLI compatibility certification. Actual installed versions, their trust/settings precedence, and provider/harness payloads must be checked in live acceptance.

### Claude

Use the shared project file as the standard source. Preserve unrelated settings, matchers, and hooks, including user handlers later added beside a managed handler. Detect wr-next hooks or disabling policies in `.claude/settings.local.json` before installation; do not rewrite that file.

The explicit `run --runtime claude --isolated` path generates an ephemeral settings file. Source-mode gating prevents installed project wr-next callbacks from handling that isolated run a second time. It does not disable other user hooks or sandbox the process.
For a native read-only child, the Coordinator first runs `wr-next delegate REF --read-only`. The returned `spawnDirective` must be the first line of exactly one foreground Agent prompt. `PreToolUse` records one owner-private pending association; `SubagentStart` consumes it using the shared `prompt_id` and actual `agent_id`; child `PreToolUse` then receives a dedicated `NativeRuntimeBridge` context. The child may use Claude inspection tools plus bounded wr-next/Git inspection shell commands. Unmarked or concurrent ambiguous starts fail closed.

### Codex

Use **one** project representation: `.codex/hooks.json`. Do not also add inline hooks to `.codex/config.toml`. Existing inline hooks at that layer produce a diagnostic requiring the operator to choose/merge the representation. Existing model/options TOML is preserved byte-for-byte.

Do not set hooks-enabled features, project trust, managed-only policy, permission grants, or bypass flags. Trust remains the runtime's decision. The installer asks the operator to review `/hooks`; installing a file is not proof that it is loaded or trusted.
Plain agent-managed startup uses Codex's required `permissionDecision: allow` marker only to return `updatedInput`. Codex core applies the rewritten command before its ordinary sandbox and approval evaluation; wr-next does not set hook-trust or permission-bypass options.

The TOML conflict detector is intentionally conservative, not a general TOML parser. Quoted/exotic structures that bypass a simple detector remain a live-settings concern; the installer does not claim full effective configuration analysis.

### OMP

Use the primary project's **extension** API, not guessed `.omp/hooks/pre` paths or a different fork's API. The generated module exports a default factory and registers through `pi.on(...)`.

Native extension discovery in the reviewed upstream documentation is **cwd-only** and can honor Git ignore rules. Consequently this profile requires launch from the initialized worktree root and reports an ignored extension as not ready. It does not walk ancestors and silently claim OMP did so.

Cross-provider discovery is not proof that every provider integration is executed. Regardless, wr-next callbacks from the wrong `--source` are inert before reading private state. The OMP factory additionally deduplicates on the host API instance, not a process-global marker that would disable legitimate reloads. Existing unrelated extensions remain untouched.

For agent-managed startup, OMP's extension returns the dispatch-prefixed input from `tool_call`. OMP revalidates and schedules that revised input before its normal approval gate; no process-global environment mutation switches concurrent tools.

## Installation safety

- Dry-run reads and computes changes only. It does not write a manifest/lock, start an authority, or execute runtime binaries.
- Parse/preflight all runtime files before committing their changes.
- Merge or remove only exact owned handlers. Do not replace the runtime's whole settings document or restore an old whole-file backup over later user edits.
- An edited managed command/matcher, missing owned entry, or duplicate is a conflict. Do not silently add a second hook or overwrite the edit.
- Repeated init/sync preserves bytes and mtime for unchanged files.
- Uninstall removes a file only if the installer created it and no unrelated content remains. Fresh-clone adoption preserves pre-existing file ownership.
- Refuse malformed strict JSON rather than destroying JSONC/comments or formatting unknown syntax.
- Reject symlinked configuration paths, dangling links, hardlinks, and group/world-writable files.
- Use a Git-private manifest and write-ahead change journal, compare current bytes before replacement, fsync, and atomic rename. The journal supports rollback of partial installer changes.
- Cooperating installers hold a lock; never steal a stale lock merely because a timeout elapsed.

These checks target accidental corruption and normal concurrent configuration editing. They are not a filesystem sandbox against a hostile process with the same OS account. There is still no cross-process atomic filesystem CAS against arbitrary non-cooperating editors.

### Interrupted installation

An unresolved journal/installer lock prevents a managed project launch. After confirming no installer process is still running, reconcile a leftover lock and use:

```sh
wr-next integrations recover
wr-next integrations sync
```

Recovery only restores paths listed in the validated journal when their current content matches the planned before/after state. If someone edited a file after the crash, recovery stops and keeps the journal. It does not overwrite that person's changes.

A changed definition from a future incompatible adapter version is not silently trusted. A definition change may require using the previous version to uninstall, or an explicit manual review before adoption.

### Git hooks have a separate boundary

`init` calls the existing Git-hook installer after runtime configuration succeeds. Existing `core.hooksPath` is not overwritten. A hook manager or drifted wr-next Git hook produces a manual-action-required result and nonzero exit, even if the runtime settings were installed successfully. The output reports those partial outcomes honestly; recovery of runtime configuration does not pretend to roll back the independent Git installer.

## Worktrees, branches, and activation

Configuration belongs to the current worktree, not to one global current task. Manifests are worktree-local under Git metadata. A fresh branch/worktree needs committed static files or its own explicit init. `run` never copies settings across worktrees.

`run --worktree NEW_PATH` may create its requested worktree, but refuses to claim/spawn when that checkout lacks the chosen integration. The created checkout is retained for inspection and explicit initialization. Existing nonempty worktree paths are not rewritten.

Three facts stay separate:

1. `installation=intact`: files match the owned projection.
2. Successful startup receipt: this root Run invoked its adapter with matching context/session.
3. Native child binding: a child has its own authority-validated Execution/capability.

`integrations` always reports activation as not-proven at repository level. A receipt belongs to a particular Run. User/global/managed settings, trust, runtime disabling flags, a missing binary, or unsupported runtime version can still prevent activation. At shutdown a missing receipt yields a warning, not a fabricated success.

For managed calls that reach the adapter, a missing/mismatched startup binding rejects PreToolUse. If the runtime never executes its hooks, no hook can enforce that rejection; normal runtime permissions remain necessary.

## Event semantics

1. Route source and managed/unmanaged context before credential lookup.
2. Verify adapter version and event name; reject malformed actor identity rather than treating it as root.
3. Guard unbound native child events before opening inherited parent context.
4. Verify static installation mode, runtime kind, private connection, session, worktree, and existing Execution.
5. Record root lifecycle and return a small current-state instruction.

Blocking failures return the provider's documented denial or exit 2. Neutral PreToolUse returns nothing: it must not grant permissions or bypass other hooks. Notification failures are diagnostic, not permission denials or fake observations.

SessionStart and identifiable compact events use stable operation IDs. A turn ID alone is not a compact-event identity: several compactions may occur within the same turn. A repeated native event ID is deduplicated; unrelated identical-looking events are not collapsed by hashing their content alone. Where the runtime gives no compact-event identity, the adapter does not promise perfect delivery deduplication.

Root SessionEnd and SubagentStop are not treated as proof that a writer OS process has exited. The launcher/harness owns that lifecycle. Rollover remains the same Run/Execution; another actual session must use an explicit new run/binding.

Only targeted PR create/merge output is considered for GitHub reconciliation. Failed tool results are ignored for success attribution. Observation of a URL is not publisher proof. No full transcript or all-tool-call log is introduced.

## Tests and acceptance

New tests cover settings preservation, idempotence, ownership-aware uninstall, fresh-clone adoption, malformed/disabled/conflicting config, symlink/hardlink paths, Git worktrees, OMP cwd/ignore behavior, lock/journal recovery, plain Claude/Codex/OMP Coordinator lifecycle, exact tool-input binding, source-mode deduplication, malformed blocking events, unbound child denial, missing startup receipt, session mismatch, and live-writer retention after advisory shutdown.

Provider tests execute synthetic hook payloads and OMP host events through actual CLI processes and the local authority. Installed-provider smoke checks remain a separate acceptance step; a synthetic process does not certify every provider version, settings layer, or interactive permission path.

Live acceptance after applying:

```sh
cd next
bun ci
bun run verify
bun run test:workerd
# In a disposable initialized repository with the intended runtime versions:
wr-next init --runtime claude,codex,omp --no-git-hooks
wr-next integrations
# Review native hook trust/settings; start one disposable managed work per runtime.
# Check startup receipt, correct Run/Work binding, neutral/blocked hooks, rollover,
# targeted PR observation and existing user-hook behavior. Do not use production work.
```

Independent native-child dispatch remains a separate acceptance task. Do not label its absence as fixed merely because project hooks have been installed.

## Primary references reviewed

- Codex hooks (official): `https://developers.openai.com/codex/hooks` (redirects to `https://learn.chatgpt.com/docs/hooks`). Project JSON/TOML alternatives, trust, event payloads and decision outputs.
- Claude settings/hooks (official): `https://code.claude.com/docs/en/settings`, `https://code.claude.com/docs/en/hooks`.
- OMP primary repository: `https://github.com/can1357/oh-my-pi/blob/main/docs/extensions.md` and `https://github.com/can1357/oh-my-pi/blob/main/docs/extension-loading.md`. Default factory, event API, cwd-only discovery and path deduplication.
- Devin's native lifecycle hook compatibility has not been established by this change. No unsupported path/API is generated.

Checked design date: 2026-09-07. Treat provider specifications as versioned integration contracts; do not infer live compatibility from this date alone.
