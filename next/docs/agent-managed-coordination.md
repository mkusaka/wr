# Agent-managed repository coordination

Status: implemented on `d51959179856bf1755f9d2d8e5ef03260e532fed`; live provider acceptance remains a separate gate.
This document describes the new implementation, not features already present in that base commit.

## Decision and ordinary use

Humans supply intent and approve the repository once. They do not manage W12-style identifiers or construct Execution/Run IDs.
A root runtime initially coordinates a repository scope without claiming implementation work. The model interprets the user's request, creates or adjusts a small plan, and selects relevant work. Readiness and atomic claiming are deterministic; choosing what satisfies the request remains an agent decision.

```sh
# Once per approved local checkout/device. Static configuration alone grants no authority.
wr-next init --agent-managed --runtime claude,codex,omp
# Optional operator-set default checks inherited by every new leaf:
# wr-next init --agent-managed --runtime claude,codex,omp --checks tests

# Ordinary session; no Work ID or launcher required.
claude  # or: codex / omp

# Optional one-shot supervised execution, choosing the highest-ranked ready leaf.
wr-next run --next -- codex
# Explicit Work selection remains supported for automation/debugging.
wr-next run W12 -- omp
```

The permanent integration files contain only static commands or extension code. Enrollment is owner-private state outside the repository and is bound to repository identity, approved worktree, device, authenticated principal, authority and scope. A clone of `.wr/config.json` or a runtime integration file cannot acquire the local operator's authority.

`init` without `--agent-managed` retains instrumentation-only semantics. Existing repositories must run the explicit enrollment command once and review runtime hook trust; no approval flags are bypassed. Git-hook installation remains separate if an existing hook manager requires manual integration.

A shared repository root is a collection: it remains open when today's jobs finish. An ordinary goal with children still completes according to its actual acceptance policy. Explicit work IDs are retained in the protocol and debugging views, not required in everyday human commands.

## Agent-facing operations

```sh
wr-next status
wr-next ready                    # inspect candidates and blocker reasons
wr-next next                     # same deterministic candidate query
wr-next next --claim             # select and claim atomically
wr-next claim REF                # agent's deliberate selection from returned refs

wr-next add 'Implement the requested API'
wr-next plan --changes '[
  {"type":"work.create","title":"Implementation","alias":"impl"},
  {"type":"work.create","title":"Review","needs":["impl"]}
]'

wr-next report --decision 'Reuse the existing API' --reason 'Preserve its contract'
wr-next report --blocked 'Waiting for the API decision'
wr-next done --summary 'Submitted the requested implementation'
wr-next yield --reason 'Need the environment repaired before retrying'
wr-next claim REF --retry --reason 'The environment is now repaired'
wr-next hold resolve HOLD_REF --reason 'Resolved my declared blocker'
wr-next delegate REF             # yields an assignment reference, not a credential
```

The model need not echo internal IDs after a claim. `plan --changes` accepts a small typed batch, not a full state replacement or a new Markdown file. Aliases refer to items created earlier in the same batch. The user never has to copy generated IDs into launch commands.

No ready item means idle, not successful completion. A work item awaiting checks is not reclaimed automatically. An interrupted/failed attempt requires an intentional retry with a reason. The guidance explicitly prohibits running unrelated ready backlog merely because a session started. This implementation does not invent new work by parsing the user's prompt in a hook and makes no background model calls.

Root notes before claim can record a decision/progress note against the coordination scope. A work blocker or result requires an actual claim. Submission retains the existing Result/Check/Acceptance distinction.

## Authorization boundary

The root has a Coordinator capability, not operator authority and not a dummy write Execution.

Allowed inside its enrolled scope:

- Create draft children and dependencies; update unattempted child requirements.
- Reprioritize or update a display phase without modifying active requirements.
- Inspect readiness; atomically claim one leaf; submit/yield its current attempt.
- Issue delegation for an approved child, with fixed role/mode.
- Cancel an unattempted child, without treating cancellation as acceptance.
- Resolve a worker hold owned by this root's work attempt after inspecting its cause.

Not allowed:

- Change the root objective, another repository/scope, approval/verification policy or resource budget.
- Resolve human/operator holds, fabricate trusted checks, publish as another Execution, or mark a result verified.
- Replan completed/attempted requirements implicitly, bypass schema/import authority, cut over/rollback, or install/disable integrations.
- Exchange a lifecycle credential for worker, Git or arbitrary check authority.

Default leaf checks are an operator-controlled template. Decomposing an unattempted template-derived leaf moves those same checks onto every new leaf; it does not discard them. An explicit parent integration-check policy is not replaced by children-v1. Independently enrolled devices share the same repository scope and policy, not each other's credentials; they can continue planning shared draft work without weakening its checks.

The default with no `--checks` is declaration-v1: an explicit submission can be accepted as a declaration. This is not machine proof of correctness. Production verification requirements should be configured at enrollment or explicitly replanned by an operator.

## Runtime identity, claim and tool assignment are distinct

```text
CoordinationGrant (private, operator-authorized)
    -> Coordinator + RuntimeAgent + Run (no Execution yet)
        -> WorkDispatch (one actual tool invocation)
            -> optional Work Execution binding
                -> Result / existing Acceptance evaluation
```

Work hierarchy, runtime parenthood, delegation and continuation remain independent relations.

- One root can handle several work items sequentially during the same Run.
- `next --claim` performs readiness/ranking/claim/assignment under one authority transaction.
- Concurrent roots cannot claim the same writer or final resource slot.
- Ranking is priority descending, then stable work key/id.
- `ready` is read-only. Claim rechecks current prerequisites, holds, environment and capacity.
- Provider Session IDs can be shared; actor + invocation disambiguates each Run.
- A context-window change does not create a Run/Execution or refresh work requirements.

The only mutable current selection is authority-side Coordinator state. An already-dispatched tool never follows that pointer dynamically.

Each tool receives a private WorkDispatch with the Execution and generation fixed when it started. A claim can fill the originally unassigned claim-tool slot; it cannot rebind a slot previously assigned to another work. Replaying that tool uses its original command receipt and cannot create duplicate work or silently adopt a newer planning revision.

`done` or `yield` requests release at the tool boundary. Other open tools assigned to that work must finish before the coordinator can take the next work. A closed slot cannot fetch credentials for the new assignment. Failed/denied tool execution closes only its exact slot; a resolved batch can retire only explicitly listed tool IDs, never all pending operations based on a timer.

## Physical ownership and process uncertainty

Work completion and physical writer termination are separate.

- The root's environment reservation remains held across its sequential jobs, even after a job is submitted and its Execution finishes.
- This prevents a second root taking the same worktree while the first runtime can still execute code.
- A trusted `CoordinatorBridge.stop(true)` asserts the controller's actual process-stop contract. `stop(false)` is advisory and does not release writers.
- SessionEnd closes new root work updates but leaves its Run unknown until positive process evidence is available.
- Local startup can reap a previous owner only when PID plus process-start identity proves it is gone; lack of permission/readability or a heartbeat timeout is not proof.
- Root termination never terminates or releases separately managed native children. They remain visible as orphaned actors and retain their own execution identity.
- An original lifecycle controller can confirm termination after enrollment revocation; it cannot create work, refresh capabilities or bypass the revoked grant.

A completed tool's late Git observation may still be recorded against its historical Execution; it never becomes the new work's candidate. Generation revocation still fences old credentials. Process ownership is not a full process-tree sandbox. Detached commands and external services must be handled by their own lifecycle contract; this feature does not prove a worktree clean or free of background writers.

## Public command, observation and query contracts

New command variants (all schema validated):

```text
coordination.enable / coordination.revoke       operator only
coordination.open                              enrolled bootstrap only
coordination.dispatch / dispatch.close         trusted runtime observer only
coordination.window / coordination.stop         trusted runtime observer only
coordination.credentials                       existing live tool only
coordination.note                              scoped decision/progress
work.claim / work.yield                        scoped coordinator tool
execution.next                                 supervised operator one-shot
```

Queries:

```text
GET /v1/ready          scoped candidates, blocked reasons, snapshot
GET /v1/coordination   this root's scope/current selection; no secrets
GET /v1/status        same projections, now with assigned-work annotation
GET /v1/runtime       runtime tree; workless coordinators are not 'unassigned' errors
```

Bootstrap credentials cannot read workspace data. Normal model-side commands cannot choose `source=observed`, actor identity or trusted checks. `effect` capability is separate from process lifecycle: coordinator-managed PR creation can begin/resolve its own effect without being able to send `runtime.ended`.

## Trusted harness interface

```ts
const bridge = await CoordinatorBridge.open(privateEnrollment.bootstrap, {
  runtime,
  session: actualSessionId,
  actor: actualRootId,
  invocation: actualInvocationId,
  environment: approvedWorktreeIdentity,
});

const env = await bridge.toolEnvironment(actualToolCallId, actualToolInput, baseEnv);
// Host executes exactly this invocation with env; the model never receives controller tokens.
await bridge.toolFinished(actualToolCallId);

await bridge.window(nativeWindowId);
await bridge.stop(false);  // advisory runtime event
// Only when host positively establishes its stop contract:
await bridge.stop(true);
```

`delegate REF` saves a raw grant privately and returns an opaque `spawnDirective`, never the grant token. Claude can consume one such assignment for one foreground read-only Agent/Task call: the directive is the first prompt line, `PreToolUse` records a single owner-private pending association, and `SubagentStart` combines the shared `prompt_id` with Claude's actual `agent_id`. Child tool hooks carry that `agent_id`, so `NativeRuntimeBridge` can issue an immutable child Execution context without inheriting the Coordinator context.

Unmarked, concurrent ambiguous, background, nested or writable Claude children remain denied. The read-only child allowlist is Claude inspection tools plus bounded wr-next and Git inspection shell commands. Codex exposes `agent_id` at child start/stop but not on child tool hooks; OMP's top-level project extension lacks a stable spawn-to-child identity. Those runtimes therefore remain fail-closed for native children and should use explicit delegated `run` processes.

## Plain runtime profiles

Claude and Codex use permanent command hooks; OMP uses its permanent project extension. None requires a `run` wrapper after explicit enrollment.

1. Session start from an explicitly enrolled checkout identifies the actual ancestor runtime process using PID + start identity and the actual provider session.
2. The trusted hook or extension uses the private enrolled bootstrap; it does not supply the operator credential to the model.
3. It opens or reuses the exact root invocation and returns bounded coordination guidance.
4. The pre-tool event binds the actual tool-call ID to a WorkDispatch.
5. Shell input receives only private file references for that dispatch. Claude passively rewrites Bash input. Codex uses its required `permissionDecision: allow` rewrite marker; Codex core still applies its sandbox and approval policy to the rewritten command. OMP returns revised input before its schema validation, scheduling and approval gate.
6. Post-tool events close the matching slot. Claude additionally handles explicit permission-denied and resolved-batch events.
7. Git hooks use the exact worker context of the shell invocation. Model CLI `report` and `done` use that same assignment.

Before claim, known read tools and bounded non-expanding management shell commands are allowed; arbitrary write shell commands are refused. Claude may start one explicitly delegated foreground read-only child as described above. All other unbound native Agent/Task/SendMessage equivalents are denied rather than silently routed to the root.

The runtime-process lookup proves only the identity under the cooperating same-user OS model. It does not infer a work item from cwd, branch, latest session or prompt text. No stable owner identity means fail closed with an explanation/fallback. Desktop/embedded/unrecognized launch layouts must use a supported bridge or `run --next` until a host identity contract exists.

Do not use repository-owned hooks as a hostile-agent sandbox. A same-user process capable of reading all local credentials is outside the capability-isolation threat model.

## Local authority restart

Enrollment records the exact authority DB and a private signing/profile fingerprint when using the managed local authority. Ambient startup may auto-start/reuse only this approved authority. A changed profile/DB/signing identity requires explicit enrollment again; remote failure never creates a local replacement.

A changed local listening port may be refreshed only after authenticating the same saved database/signing profile. That refresh changes transport endpoints, not work assignments, grant identity or scope. Existing queued records aimed at an old endpoint are not blindly redirected across authorities; unresolved sync remains diagnostic work rather than false completion.

`init --agent-managed` can explicitly renew/re-enable a registration. Revocation advances grant generation; old root/bootstrap/child credentials are not revived by re-enrollment.

## Supported boundaries and known limits

| Path | Code/test status |
| --- | --- |
| Coordinator commands, claims, scope, lifecycle | Implemented and tested with real local HTTP/SQLite |
| Plain Claude startup and per-tool hook binding | Implemented; generated hooks executed by a synthetic Claude-named OS process |
| Plain Codex startup and per-tool hook binding | Implemented against the official rewrite contract; synthetic tool flow passed and installed Codex 0.153.4 executed start/end hooks |
| Plain OMP startup and per-tool extension binding | Implemented; installed OMP 18.1.12 completed a model-driven add/claim/done flow with the wr-next extension loaded last |
| Remaining provider acceptance | Real Claude and Codex tool calls; Codex tool smoke was blocked by the active account usage limit |
| Native children | Claude foreground read-only Agent/Task is bound and process-tested; nested/background/writable Claude children and Codex/OMP native children remain guarded |
| Devin | Generic supervised execution only |
| Bun/workerd after this patch | Accepted on Bun 1.4.2 with 224 tests and the real workerd smoke test |

Codex requires `permissionDecision: allow` whenever a trusted hook returns `updatedInput`. In Codex core this marker enables the hook rewrite; the resulting input still passes through core sandbox and approval evaluation. Codex hooks and OMP extensions use last-rewrite-wins composition. A later input rewriter can remove wr-next's private dispatch prefix; the resulting CLI or Git operation fails closed as unbound rather than falling back to ambient work. OMP users with another input-rewriting extension must arrange for wr-next to load last or use an explicit trusted harness until the host offers composable input middleware.

Additional limits:

- Same-process session switching (for example `/clear` with a new session ID) is not an automatic writer handoff. A second invocation must not steal a still-live owner. Restart/rebind deliberately or implement the runtime's explicit session-switch contract.
- Long-running credentials are bounded. Interactive OAuth renewal, seamless controller rotation and all-provider reconnect are not newly implemented. Expiry requires explicit renewal/restart, not operator fallback.
- Automatic clean-worktree proof, arbitrary detached process control and automatic worktree provisioning are not added here. Separate concurrent writers need approved separate environments.
- Unknown tool/OS layouts, missing hook receipts and unsupported payload identities remain visible failures. A successful mock is not proof a user's CLI version supports the profile.
- Planning a check does not authorize a worker to assert it passed. Trusted collection remains distinct.

## Storage and rollout

New `coordinationGrants`, `coordinators`, `dispatches` tables and optional links in existing records are migrated under schema version **3**. Existing historical Result/Check/Acceptance and runtime records remain. No old wr D1 schema, binary or release configuration changes.

1. Stop wr-next authority and take a consistent backup of its SQLite/private state.
2. Apply the patch based on `d51959179856bf1755f9d2d8e5ef03260e532fed`.
3. Run `bun ci`, `bun run verify`, and `bun run test:workerd` on supported Bun.
4. In a synthetic/disposable test repo run `wr-next init --agent-managed --runtime claude,codex,omp`, review actual runtime hook trust, and start OMP from the initialized worktree root.
5. Test each live runtime: session start without Work, inline plan, explicit/atomic selection, reports, submission, permission denial, concurrent tools, compact/resume, parent/child boundaries and Git provenance.
6. Enable one actual development repo only after live acceptance. Do not deploy/rename/replace production wr automatically.

Rolling back the binary may require restoring the version-2 DB backup; older binaries reject a version-3 store. Merely switching source code is not a data rollback.

## References

Baseline source: `mkusaka/wr@d51959179856bf1755f9d2d8e5ef03260e532fed` (`next/` generic binder/permanent integrations).

Official runtime contracts checked for this design:

```text
https://code.claude.com/docs/en/hooks
https://developers.openai.com/codex/hooks
https://github.com/can1357/oh-my-pi/blob/main/docs/extensions.md
https://github.com/can1357/oh-my-pi/blob/main/docs/extension-loading.md
```

Claude supports passive `PreToolUse` input rewriting, exact tool IDs and explicit failure/denial/batch completion events. Codex requires an explicit allow control marker for `updatedInput`, while core retains sandbox and approval evaluation. OMP applies revised `tool_call` input before validation, scheduling and approval. These references define the adapter contracts; installed-version interoperability remains a live acceptance step.
