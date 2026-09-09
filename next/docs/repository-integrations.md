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

A static hook installer is not a work allocator, hook trust approver or completion evaluator. Claude and Codex expose a narrow explicitly delegated read-only native-child profile; `run` remains useful for process ownership, writable work, explicit binding and generic workers. Other native harnesses can use `NativeRuntimeBridge`; every agent is not required to be an independently wrapped subprocess.

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
| Codex | `.codex/hooks.json` | Plain Coordinator bootstrap and exact per-tool rewrite using the documented control marker | Explicit MAv1 read-only children: exact spawn receipt, bounded child binding, and verified same-root send/wait; MAv2/nested/writable/close/resume remain denied |
| OMP | `.omp/extensions/wr-next.ts` | Plain Coordinator bootstrap, revised tool input, compact window and advisory shutdown | OMP 18.1.13: explicitly delegated read-only native `task` children, preserving native `hub` conversation |
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
Startup context output follows each provider's schema: Codex receives only `hookEventName` and `additionalContext` in `hookSpecificOutput`. The private `wrNextActive` activation marker is emitted only to the OMP extension; Codex rejects that extra field.

The TOML conflict detector is intentionally conservative, not a general TOML parser. Quoted/exotic structures that bypass a simple detector remain a live-settings concern; the installer does not claim full effective configuration analysis.

**Production MAv1 profile.** Run `wr-next delegate REF --read-only` first. For the `message` string, or for exactly one text item when content is itemized, put the returned `WR_NEXT_ASSIGNMENT=…` directive on its first line in one `spawn_agent`, `Agent`, or `multi_agent_v1spawn_agent` call. Missing, repeated, or ambiguous directives are denied. Root `PreToolUse` stores the exact pending association `(root bridge, root session, spawn tool-use ID)`; only a successful root `PostToolUse` containing `{ "agent_id": "UUID" }`, as an object or JSON-encoded string, binds the child through `NativeRuntimeBridge` and atomically publishes that receipt.

Child `SubagentStart` and `PreToolUse` each wait at most 3 seconds for the receipt keyed by the shared root session and actual child UUID. An absent, malformed, or binding-error receipt explicitly denies `PreToolUse`; it never falls back to the root Coordinator context. A bound child has inspection tools and only bounded `managementCommand` wr-next/Git shell inspection. Its normalized Codex Bash input receives `permissionDecision: allow` and an immutable child context prefix; Codex still applies its own sandbox and approval policy. Native `send_input` and `wait_agent` remain available only among verified same-root peers (including sending to the root UUID); waiting may target only a verified child. `SubagentStop` only records the child as quiescent. No root Work claim is needed for the supported spawn or peer controls.

MAv2, nested spawning, writable children, and close/resume controls are denied in this initial profile. Exact MAv2 collaboration spawn/control names and unsupported aliases are guarded against wrapper-context inheritance rather than routed through the root. This is same-user cooperative coordination, not a hostile-agent sandbox or a hard authorization boundary.

**Operator-owned prerequisites.** Enable/trust project hooks and select MAv1 (`features.multi_agent = true`, `features.multi_agent_v2 = false`). Stock Codex 0.153.4 hides all MAv1 tools from a child at its configured depth limit, including messaging: `agents.max_depth = 2` exposes first-level child conversation; wr-next still denies nested spawning. The sandbox must permit writes to the private wr-next state directory and connections to its authority. A read-only filesystem or blocked loopback network prevents `delegate`, `status`, and `done`; hook input rewriting does not bypass either restriction. The installer changes none of these settings.

**Integrated smoke on stock Codex 0.153.4 (2026-09-08).** The generated project hooks and production coordinator adapter passed with two concurrent read-only children: exact spawn UUIDs matched separate W2/W3 Executions, each child's `status` showed only its own Work, both Works reached done, both children became quiescent, and the root retained no Execution. Native root-to-child, child-to-root, sibling `send_input`, and root `wait_agent` succeeded; no `wr-next run` wrapper was used. Only model responses were deterministic local fixtures, not hosted-model output. The disposable home/checkouts used `agents.max_depth = 2`, workspace-write sandboxing with only the temporary wr state added as a writable root, and authority network access. Hook-trust bypass was confined to vetted temporary hooks; no ordinary user settings or provider credentials were used.

**Historical forkless experiment on stock Codex 0.153.4 (2026-09-08).** Native child identity and assignment correlation do not require a fork. For MAv1, the experiment recorded the explicit assignment against the parent's spawn tool-call ID, then published the exact child UUID from spawn `PostToolUse`. A child startup or pre-tool hook could wait for that publication without deadlocking the parent. It established the runtime mechanism, not hosted-model behavior or the production-integrated wr-next smoke.

The experiment used the installed, unmodified `codex exec` binary, native spawn/wait tools, real hook subprocesses and real `printf PROBE_A` / `printf PROBE_B` execution. Only Responses API model output was supplied by a deterministic loopback server. Each run used a disposable `CODEX_HOME` and checkout, with no provider credentials. `--dangerously-bypass-hook-trust` was confined to these vetted temporary hooks; it is not part of the installed integration and no normal user settings were changed.

| Scenario | Observed result |
| --- | --- |
| Two native children; startup gate; B executes before A | Both commands returned their own marker under the correct child UUID/assignment. A's mapping appeared 492 ms after its startup gate began; the gate released 8 ms later. No deadlock. |
| No startup wait; first child tool races parent publication | A's pre-tool hook waited 318 ms for its mapping, released 10 ms later, and executed successfully. Both children completed. |
| B's mapping deliberately never published | Startup wait expired; B's pre-tool hook returned an explicit deny. A executed; B did not. |
| Unbound B's pre-tool hook exits 2 with stderr | B did not execute. |
| Unbound B's pre-tool hook exits 1, emits malformed JSON, or exceeds the runner timeout | In all three separate runs, B still executed and returned `PROBE_B`. Stock hook runner failures are fail-open. |
| MAv2 persisted-session profile | Spawn returns a canonical task path, not a UUID. Reading only the exact hook-provided transcript's `session_meta` supplies the child UUID, shared root session, parent thread and canonical `agent_path`. Matching all of those to the parent's published task-path receipt allowed both children to execute under their own assignments, with B before A. |

Decision: the production profile uses the version-pinned forkless MAv1 correlation mechanism with bounded waiting and explicit pre-tool denial when no exact binding exists. It does not use the latest pending spawn, a task-name-only guess, or root context as a fallback. MAv2 additionally depends on its persisted rollout metadata contract and remains guarded rather than reusing the UUID-only path. The historical experiment covered ordinary two-child spawning, not nested/reopened agents, ephemeral MAv2 sessions, or the production-integrated wr-next smoke.

**Hard fail-closed authorization is a separate requirement.** A functioning hook can deny missing assignments, but it cannot force stock Codex to deny when the hook runner itself fails. If direct native tools must remain blocked even during hook failure, a host-side fail-closed policy remains necessary. This—not absence of child identity—is the remaining reason to consider a Codex fork.

Source inspected at `ca6fb194b695dda38d8ccfcb5871b4dbd334b960` supports the observed scheduling: `core/src/hook_runtime.rs` includes child `agent_id = sess.thread_id()`; `core/src/agent/control/spawn.rs` submits child input without waiting for its turn to finish. The child's startup hook is awaited on the child turn, not on the parent's spawn completion.

An optional lineage fork would simplify the adapter and remove its post-result wait. Add optional persisted `spawn_tool_use_id` to `SubAgentSource::ThreadSpawn`; derive `parent_agent_id` from its existing `parent_thread_id`. Populate both native spawn implementations, preserve the field through source reconstruction/resume, and serialize both fields in `SubagentStart` and child tool hooks. `(root session, parent actor, spawn call)` would then select the exact private assignment at startup. Old histories without lineage stay unbound. This simplification is not a prerequisite for the forkless mechanism verified above.

Relevant Codex files are `protocol/src/protocol.rs`, `core/src/tools/handlers/multi_agents_common.rs`, both native spawn handlers, `core/src/agent/control/spawn.rs`, `core/src/hook_runtime.rs`, and `hooks/src/events/{common,session_start,pre_tool_use}.rs`. Source tests in `core/tests/suite/subagent_notifications.rs` and app-server `tests/suite/v2/turn_start.rs` cover the surrounding lifecycle. A fork acceptance test must additionally cover concurrent reversed-order starts, nested actors, resume, both multi-agent versions and absent old-history lineage.

Stock hooks are not a hard authorization boundary: `hooks/src/events/pre_tool_use.rs` leaves `should_block=false` for runner failure, malformed JSON and ordinary nonzero exit. A designated fail-closed synchronous hook policy would be a separate opt-in fork change; do not change all unrelated hooks globally. App-server collaboration events expose sender/receiver thread IDs but arrive as observations, not a pre-first-tool authorization latch.

Hook-facing names are version-sensitive. For MAv1, supported root spawn names are `spawn_agent`, `Agent`, and `multi_agent_v1spawn_agent`; canonical peer controls are `multi_agent_v1send_input` and `multi_agent_v1wait_agent`, with `send_input`, `wait_agent`, and `wait` treated as legacy aliases. `resume_agent`, `close_agent`, and their MAv1 forms are denied. MAv2 `collaborationspawn_agent` and its collaboration control names (`collaborationsend_input`, `collaborationwait_agent`, `collaborationresume_agent`, `collaborationclose_agent`) are guarded, not accepted. Do not confuse model-facing namespace syntax with hook-facing names. No Codex fork has been created or published.

### OMP

Use the primary project's **extension** API, not guessed `.omp/hooks/pre` paths or a different fork's API. The generated module exports a default factory and registers through `pi.on(...)`.

Native extension discovery in the reviewed upstream documentation is **cwd-only** and can honor Git ignore rules. Consequently this profile requires launch from the initialized worktree root and reports an ignored extension as not ready. It does not walk ancestors and silently claim OMP did so.

Cross-provider discovery is not proof that every provider integration is executed. Regardless, wr-next callbacks from the wrong `--source` are inert before reading private state. The OMP factory additionally deduplicates on the host API instance, not a process-global marker that would disable legitimate reloads. Existing unrelated extensions remain untouched.

For agent-managed startup, OMP's extension returns the dispatch-prefixed input from `tool_call`. OMP revalidates and schedules that revised input before its normal approval gate; no process-global environment mutation switches concurrent tools.

OMP 18.1.13's public `task:subagent:lifecycle` event supplies the actual child ID, parent tool-call ID, batch index and child session file before child startup. The extension records each `task` prompt's explicit assignment and matches the child's `session_start` to that exact tuple. Each child receives its own runtime actor and Execution; no cwd/latest-child guess or process-global context switch is used. An unmatched child session is denied rather than bootstrapped as a root.

Delegate each Work with `wr-next delegate REF --read-only`, then put its returned `spawnDirective` on the first line of the corresponding native `task.tasks[].task`. The built-in tool still creates the children. Native `hub` peer send/list/inbox/wait remains available to both root and children, including sibling conversation. Children retain native `yield` for incremental and terminal result submission. Bounded inspection and wr-next/Git inspection shell commands are allowed; writes, arbitrary shell, eval, nested spawning and process-control hub operations are denied. The native binding is version-gated to 18.1.13; other versions retain root integration but cannot use this native task profile. Unenrolled installations remain inert.

Installed OMP 18.1.13 was exercised with two concurrent native children and native root/child and sibling messaging, using `--no-extensions -e .omp/extensions/wr-next.ts` to isolate the extension. Other input rewriters still require wr-next to load last. This is not acceptance of arbitrary plugin stacks or writable/nested child profiles.

**Normal-stack repair (2026-09-09).** Stock OMP 18.1.15 passes the original input to every `tool_call` handler and keeps only the last result. An existing environment-injection extension therefore removed wr-next's command prefix, producing `UNBOUND_COORDINATOR` on `claim`. A local host patch now passes the effective input to each subsequent handler and retains it through non-input results, without changing blocking/cancellation precedence. With that patch installed, the ordinary extension stack and a real model completed `plan`, `claim`, `report`, and `done`; the authority confirmed the Work was done. No extension was disabled and no `run` wrapper replaced the native root.

This is a locally patched 18.1.15 host, not an upstream release guarantee. A stock binary update can remove the fix. Keep the patch until upstream provides equivalent composition and re-run the normal-stack smoke after upgrades. The repaired root flow does not extend the version-gated 18.1.13 native-child profile to 18.1.15.

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
