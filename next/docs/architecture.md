# Architecture and interface contract

## Boundary

`next/` is a standalone successor. It never imports root `src/`, reuses the old schema, shares the old token cache, or installs over `wr`. External issue IDs are optional references. Users see WorkItem, not Task/Workstream/Checklist type choices.

The main flow is `add/plan -> run -> report/done -> checks -> acceptance -> status/graph`. Native context rollover continues the current Run/Execution. Restart/resume creates a new Run and can reference a stopped predecessor with `--continue EXECUTION`.

## Design principles

- **Work first:** users operate on a WorkItem. Session, Run and Execution identifiers are recorded automatically rather than becoming routine user input.
- **Intent, observation and derivation stay distinct:** an agent can submit a result, but it cannot assert that Git, CI or review evidence was observed. Trusted adapters and hooks record observations; the authority derives readiness and acceptance.
- **Completion is version-bound:** `done` submits an immutable result. Only the configured policy can accept that result for the current scope and exact artifact. Scope or artifact changes invalidate current acceptance without erasing history.
- **Coordination fails closed:** dependency conflicts, stale contexts, uncertain process launches and ambiguous external effects stop for explicit recovery instead of guessing.
- **One source of truth, many projections:** status text, JSON, workpads, Mermaid and resume context come from the same transactional snapshot. Generated documents are not writable authority.
- **Migration is reversible:** imported state begins read-only, unsupported semantics are rejected, authority changes happen per scope, and rollback preserves successor history.
- **The successor is isolated:** its binary, state, credentials, hooks and remote storage remain separate until an explicit production cutover.

## Data model

- Work: current intent, hierarchy, policy, revision and scope revision.
- Dependency: accepted prerequisite or explicitly imported legacy predicate.
- Session: runtime conversation identity.
- Run: CLI invocation, runtime metadata, observed session and context windows.
- Execution: work/run association, role, scope snapshot, dependency basis, continuation and generation.
- Reservation: coordination ownership of work environments/resources. It does not sandbox filesystem access.
- Result: immutable submitted manifest and summary.
- Check: exact-subject collector observation; repeated identical snapshots do not spuriously invalidate downstream work.
- Acceptance: immutable fingerprint of scope, policy, result, prerequisite acceptances and check evidence.
- Artifact/context/contribution/rewrite: Git identity, context binding, role and source.
- PR: current exact head/membership plus previous versions, observations and publisher receipt.
- Delegation: scoped, expiring, single-use child assignment.
- Effect: prepared/unknown/succeeded external operation. State must be claimed before calling an external creator.
- Source: imported scope, source digest, mapping and shadow/next/legacy authority mode.
- Events and operations: append-only history and idempotency receipts.

## Existing wr migration boundary

Migration from the existing wr database is feasible, but it is not a row-for-row schema copy and no direct wr/D1 importer is implemented yet. The safe path is a versioned read-only export, deterministic dry-run mapping into a shadow scope, comparison, and then an explicit per-scope authority change.

- Existing Tasks map to WorkItems; `issueId` becomes an external reference rather than the WorkItem identity.
- Existing CLI sessions, session runs and executions can be retained as historical provenance. They do not establish current reservations, publisher identity or accepted results.
- Existing task/PR relationships can be retained as references, but current HEAD, commit membership, reviews and checks must be observed again from GitHub.
- Existing `done` status has no Result/Check/Acceptance evidence, so it must remain a legacy completion claim until explicitly accepted under a migration policy.
- Device-local checkout paths and credentials are not portable shared state. They must be rediscovered or reissued on each device.
- Workpad and conversation links can be retained as references without copying their private content.

The existing wr database and binary remain untouched throughout migration. Unsupported or ambiguous records stop the import with diagnostics; they are never silently upgraded into stronger successor facts.

## Transactions

The domain engine loads and mutates one workspace state inside one synchronous SQL transaction. Store persists changed entity rows plus metadata and an operation receipt. Event history is not the only source of current state. This deliberately simple implementation is suitable for small workspaces; the 5,000-work limit is not a throughput guarantee, and accumulated event history still needs operational retention/scale planning.

Bun SQLite and Durable Object storage use the same engine, table definitions and SQL port. The Bun adapter is a development authority, not a second offline master. A future SQL/query optimization may remove whole-workspace loads without changing command semantics.

A start checks current dependencies, holds, writer/resource reservations and capacity before creating the Run/Execution atomically. Process spawn happens outside SQL. An unclear spawn receipt is never an instruction to blindly spawn again. Recovery requires explicit stopped-process confirmation. Generation fencing blocks stale API writes but cannot stop an old OS process.

## Completion

- `declaration-v1`: explicit result; marked declared, not tested.
- `children-v1`: nonempty required children all have current valid acceptance.
- `evidence-v1`: result plus named successful checks on the same subject.

Changing scope, prerequisites or an observed candidate can invalidate current acceptance while preserving its history. Exit zero, CI green and a prose handoff alone never create a result. A result/acceptance does not release a live writer reservation.

## HTTP

All routes require authenticated workspace context and reject cross-origin browser requests.

| Route | Contract |
|---|---|
| `POST /v1/commands` | Typed planning, execution, reporting, result, effect and migration operations |
| `POST /v1/observations` | Runtime/Git/GitHub/check collector observations |
| `POST /v1/capabilities` | Operator-only scoped collector issuance |
| `GET /v1/status?work=&since=&offset=&limit=` | Scoped current frontier and paged changes |
| `GET /v1/graph` | Same renderer-independent snapshot |
| `GET /v1/work?work=` | Current requirements, executions, results, holds and checks |
| `GET /v1/effect?id=` | Current scoped external-effect receipt |
| `GET /v1/explain/commit?repo=&sha=` | Artifact binding, contributions, rewrite history, gaps |
| `GET /v1/explain/pr?repo=&number=` | PR metadata, exact membership, contribution coverage and gaps |
| `GET /v1/snapshot` | Operator-only snapshot for shadow comparison/diagnostics |

```json
{"schemaVersion":1,"operationId":"stable-request-id","expectedRevision":42,"command":{"type":"work.plan","changes":[]}}
```

`expectedRevision` is optional for append-only reports but used by CLI planning. The CLI does not silently rebase on a 409. Identical operation IDs/hash replay; conflicting payloads are rejected. Runtime IDs and provenance source are determined by the context and authenticated capability, not arbitrary LLM fields.

Input validation uses a small strict discriminated command parser. Unknown keys, reserved prototype keys, invalid enums/SHA, oversized bodies and unsupported operations are rejected. There is no SQL, arbitrary server-shell or full-state replacement endpoint.

## Context and credentials

`run` creates a private context file referenced by `WR_NEXT_CONTEXT`. Worker commands resolve their work from it. Different child launches receive distinct scopes. No global `current-work.json` exists; cwd alone never establishes agent identity.

The launcher stores an executable name/argument count, not full command-line secrets or prompts. Context, capabilities, local credentials, effects and outbox are owner-private files. Some private idempotency receipts contain capability-bearing responses; treat the entire database/state directory as confidential.

Cloudflare Access transport and internal work capabilities are distinct. Membership is checked at the gateway; device ownership at mutation. Trusted-local-OS is the boundary: a model with unrestricted shell under the same UID can access files available to that UID. This is not malicious-host attestation.

## Sources

Declared operations, observed facts and derived state remain different. Git hooks establish the committer context, not every editor of a diff. Co-authors require explicit declaration; rewrites do not replace original implementers. Unknown/conflicting provenance remains a gap.

No full transcript, provider secret, raw environment or hidden reasoning is stored as a normal event. Notes/history/Entire/Posthorse remain optional evidence providers. Runtime restore reads current requirements and status; old handoff prose cannot override live state.

## Projection

Text, JSON, workpad and Mermaid use one snapshot revision. Generated output is not a writable second source of truth. Requirement truncation and pagination are explicit. Notes/decisions are authored content, current status is derived. The Mermaid renderer emits a bounded escaped grammar with deterministic node and edge order; an external Mermaid parser is not bundled.
