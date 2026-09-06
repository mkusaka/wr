# Generic binder and permanent integrations

Status: implementation contract, following `9954b20d36638e4944cd10bad34fc4dd1ca2c8fd` and the previously delivered project-integration patch.
This is not a new storage model or a claim of live native-provider acceptance.

## Decision

Keep the public operation `wr-next run WORK -- COMMAND`. Make its process binder runtime-neutral.
The normal launch path never installs hooks, writes provider settings, appends provider flags, or interprets provider payloads.

| Boundary | Responsibility |
| --- | --- |
| `init` / `integrations` | Versioned, permanent, repo-owned instrumentation; trust remains the runtime/user's decision |
| `cli/run.ts` | Resolve the actual worktree, choose/check an integration profile, then call the generic binder |
| `runtime/launcher.ts` | Claim work, issue a private execution context, spawn an explicit argv, record direct-child lifecycle |
| `runtime/supervisor.ts` | Observe spawn/error/exit without treating advisory events as process termination |
| `integrations/runtime/*` | Decode provider events, apply provider guard rules, render provider responses |
| `runtime/native.ts` | Trusted harness-side native actor binding, per-tool context, lifecycle and resume view |
| `pr create` | Explicit external effect with work attribution and idempotency; not an automatically replayed hook |

`run` is still a small supervisor, not an `exec` replacement. After replacing itself with `exec`, a launcher cannot execute its own post-exit handler. A future exec-only mode would need an independent observer and must not pretend to retain process ownership.

## User model

```sh
wr-next init
wr-next run W12 -- claude
wr-next run W13 -- codex
wr-next run W14 -- omp
```

No per-invocation settings or internal IDs are required. `wr-next status`, `report`, and `done` continue to resolve the managed worker's private context.
`init` does not claim a job, start an authority, grant hook trust, or start tracking ambient sessions.

An explicit `--isolated --runtime claude` remains for existing tests and one-shot integrations. The exceptional settings preparation lives in `integrations/runtime/launch-profile.ts`, before the binder is called. This is not the normal path and is not an OS sandbox. The supplied command's own arguments are otherwise unchanged.

For an integration-aware library call, use `runWork` from `cli/run.ts`. Low-level `launch` accepts a pre-resolved `environment` and optional opaque instrumentation descriptor. It does not discover a Git checkout or select a provider. When calling it directly with Git hooks enabled, the caller must pass the actual worktree Git-directory identity. Examples now use `runWork` so that this prerequisite is not silently dropped.

## What was simplified

1. **No concrete runtime in the binder.** No Claude/Codex/OMP/Devin branch, provider allowlist, config generation or event callback belongs to `runtime/launcher.ts`.
2. **One context instead of two.** New runs no longer write `runtime-connection.json`; its launcher capability was already present in `context.json`. Old sidecars are read only for in-flight compatibility and still checked for binding conflicts.
3. **One context issuance function.** Managed subprocesses and native per-tool dispatch use `writeExecutionContext`. It whitelists transport, execution and capability fields, instead of copying an operator/broker config and hoping every privileged field gets overwritten.
4. **One resume view.** Static SessionStart/compaction handling and `NativeRuntimeBridge.resumeContext(agent)` use the same bounded, live-state guidance. Reading a changed scope does not silently adopt that scope. No independent memory or compaction engine is added.
5. **Process identity is independent.** Authority start/stop imports `runtime/process.ts`, not the launcher and its provider dependencies.
6. **One event pipeline.** The old `internal runtime-event` path is a compatibility shim into the same provider decoding/capture pipeline, not another copy of lifecycle logic.
7. **One destination preflight.** Integration readiness is checked for the checkout actually being launched, not redundantly for source and destination. Worktree creation remains explicit; a failed preflight does not delete a user's checkout.

The context file remains an operational capability bundle for cooperating tools on a trusted local OS. It is not isolation from a same-user process that can read all private state. Removing a duplicate file does not create or weaken a sandbox guarantee that never existed.

## Normalized events, without flattening their meaning

Provider modules currently consume the documented command-hook envelope. OMP's generated extension translates its native extension events into that envelope. The common shape is not a claim that arbitrary raw provider events are interchangeable.

```ts
type RuntimeEventKind =
  | "session_started"
  | "context_compacted"
  | "session_ended"
  | "tool_started"
  | "tool_finished"
  | "child_started"
  | "child_quiescent";
```

Events retain the runtime, provider hook name, session identity, optional actor identity and optional native event ID. A provider turn ID is not used as an event ID: one turn can compact more than once.

- `SessionEnd` is advisory; it does not release a writer reservation.
- `SubagentStop` means `child_quiescent`, not `process_stopped`.
- Tool completion is not Work completion.
- A context rollover is not a new Run or Execution.
- Failed tool output is not promoted into successful PR observation.
- Native children without a trusted per-tool work binding are denied/ignored according to the hook type, never routed to the parent.
- New Claude `SendMessage` guard prevents another unbound native-control path from bypassing the existing Agent/Task guard.
- Unrelated raw prompt/token fields are not carried into the normalized envelope. Raw tool output is temporary input for observer matching, not a new full-transcript archive.

Source routing happens before context/credential reads. Cross-discovered hooks and unbound ambient sessions do nothing. Installation integrity, a verified startup receipt and native-child binding remain distinct states.

## Process errors are evidence, not exit-code conventions

The supervisor distinguishes:

```text
spawn failed before a process existed  -> launch_failed
spawn succeeded; program exits 127     -> ended(exitCode=127)
spawn succeeded; kill/send error       -> unknown observation; continue waiting
spawn succeeded; OS exit by SIGUSR2    -> ended(signal=SIGUSR2, matching numeric exit code)
```

A record callback failure must not throw from an event emitter and detach the supervisor from a live child. It records uncertainty where possible and keeps observing. A confirmed exit can then close the same direct-child attempt. Observation-sync failure does not overwrite the command's actual exit code.

A preparation failure after claim but before spawn can safely report `launch_failed`. An ambiguous post-spawn failure cannot. Lifecycle observations use stable operation IDs for that launch/phase.

The receipt states `processOwnership: direct-child`. This only proves the process directly spawned by `run`. It is not proof that every detached grandchild or external service has stopped. Native child reservations remain separate; a harness may report `ended` only when its tool/process contract permits it. Do not use this launcher as a job-tree killer or an OS write sandbox.

## Wrapperless attach: reuse the existing bridge, do not guess a Session

The implemented wrapperless interface remains:

```ts
const bridge = await NativeRuntimeBridge.attach(connection, {
  work,
  runtime,
  externalSessionId: actualSessionId,
  agentId: actualRootAgentId,
  invocationId: actualInvocationId,
  environment: actualWorktree,
}, stableAttachOperationId);

const guidance = await bridge.resumeContext(bridge.root);
const toolEnv = await bridge.toolEnvironment(actualActorId);
```

The caller is the trusted runtime/harness. Neither the model nor a random hook payload chooses another actor's capability. No OS process is spawned by this API. Native creation still uses the existing child observation, delegation and binding contracts.

This change does **not** implement a general `attach WORK --session ID` CLI. The proposed PendingBinding keyed only by provider Session is insufficient:

- a resumed or concurrently opened session can have multiple invocations;
- the same provider Session may be shared by several native actors;
- the hook must be able to return a private per-tool binding, not merely observe a SessionStart;
- an expired or replayed attach request must not bind a different run;
- an attach cannot claim supervisor-level OS-stop evidence it does not have.

A future public late-attach flow needs an observed `(workspace, device, runtime, session, actor, invocation)` plus a one-use pairing/challenge and an explicit work grant. It should reuse RuntimeAgent/Delegation binding rather than introduce a second global current-work pointer. If a runtime cannot install a per-invocation or per-tool context, report that limitation and keep `run` as its supported path.

Claude's environment-persistence hook is not a generic cross-provider parent-environment mutation API, and does not on its own establish native-child work identity. No trust bypass or transcript guessing is added here.

## Compatibility

- No DB schema, migration, auth role or Acceptance semantics change.
- Existing v1 static hook commands still work; their normal configuration content is unchanged from the previous init delivery.
- Existing legacy callback paths remain as shims. Legacy PreToolUse errors now fail closed (exit 2), rather than inheriting Git recording's best-effort exit-zero behavior.
- Git recording itself keeps its existing best-effort semantics; existing non-wr Git hooks are not weakened.
- New contexts contain one lifecycle credential path; old matching sidecars are supported while old runs finish.
- `cliPath` remains re-exported from the former Git module for old consumers; new code uses `cli/entrypoint.ts`.
- `processIdentity` remains re-exported from the launcher for old consumers; authority code uses its direct module.
- None of these changes establishes live-provider or complete native-subagent support.

## Validation

The new tests assert that generic runtime modules cannot import provider integration or Git-installer code. They also cover verbatim argv, credential/env whitelisting, absence of generated settings/sidecars, error-after-spawn behavior, record failures, signal codes, common event decoding, native resume without another Run, and legacy fail-closed behavior.

The integration demo specifically exercises Git's actual worktree identity through `runWork`; moving environment resolution out of the binder must not silently break commit provenance.

The cumulative change was accepted on Bun 1.4.2 with 182 tests, the local integration proof, and the repository's real workerd smoke test. Live Claude/Codex/OMP hooks and native-harness behavior remain separate acceptance gates.

## Primary documentation consulted

- Node child-process spawn/error/exit contracts: `https://nodejs.org/api/child_process.html`
- Bun Node-compatible spawn API: `https://bun.com/reference/node/child_process/spawn`
- Claude command hooks, SessionStart environment persistence, subagent lifecycle: `https://code.claude.com/docs/en/hooks`
- Codex hook schemas and lifecycle: `https://developers.openai.com/codex/hooks`

The new internal module layout and conservative late-attach boundary are design decisions, not features claimed to be implemented by those runtimes.
