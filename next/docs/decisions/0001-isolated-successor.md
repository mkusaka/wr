# ADR 0001 — Isolated successor and executable validation

Status: implemented for local verification; remote cutover not approved.

The conversation's final contract is all M1–M4, not an M1-only prototype. The implementation stays under `next/`, with its own package/config/binary/storage and a draft delivery path. Old wr remains unchanged apart from isolated formatter/linter scoping and a new independent CI job.

## Concrete tooling choice

The successor uses TypeScript on Bun, with Bun's SQLite implementation for the local authority, a strict typed input parser and a small Fetch API router. There are no runtime npm dependencies. Development dependency versions are pinned in `bun.lock`.

The selected production authority remains a SQLite-backed Durable Object. The local Bun SQLite port runs the identical domain/SQL contract; it is not a second synchronization backend. Remote network/API/process effects stay outside the synchronous transaction. Neither the custom parser/router nor local port is intended as a new general framework.

Real workerd and provider/remote GitHub checks remain separate opt-in verification.

## Rollout

No old schema extension, dual-write, root release rewrite, force push, production deploy or old binary replacement. Imported scopes start read-only. Cutover and rollback require operator confirmation and stopped writers. Full live M4 remains a release gate, not a status inferred from a synthetic demo.
