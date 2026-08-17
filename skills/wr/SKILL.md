---
name: wr
description: Work on the wr relationship-ledger service itself. Use for changes to the Cloudflare Worker, CLI, Web UI, schema, migrations, local validation, or service architecture; use the repo-local ops-wr skill for operational procedures such as remote D1 migration and Wrangler authentication.
---

# wr service

`wr` is a relationship ledger for tasks, CLI sessions, Git checkouts, pull requests, and workpads. Durable data lives in Cloudflare D1 behind a Cloudflare Worker.

## Source boundaries

- `worker/schema.ts` is the schema source of truth.
- `worker/` contains the Worker API and persistence logic.
- `src/` contains the CLI and local Git, GitHub, and iTerm2 integration.
- `web/` contains the Web UI.
- `migrations/` contains generated Drizzle SQL and metadata.
- `wrangler.jsonc` contains the Worker and D1 binding configuration.

Keep service behavior changes in these sources. Do not edit generated migration metadata by hand; generate it from the schema.

## Development workflow

Install dependencies and run the focused checks relevant to the change:

```bash
bun install
bun run db:check
bun run typecheck
bun run lint
bun run test
bun run build
bun run compile
```

For a schema change, edit `worker/schema.ts`, generate the migration, then check it:

```bash
bun run db:generate --name=describe_change
bun run db:check
```

Remote D1 operations, including migration history inspection and applying a migration, belong to the repo-local `$ops-wr` skill. Do not use `wrangler d1 migrations apply --remote` blindly when the database already has Drizzle migration history.

## Product boundaries

- The Worker owns every durable read and write.
- D1 is accessed through Drizzle ORM.
- Cloudflare Access authenticates browser and CLI users through the same identity provider.
- A locally generated UUID identifies a Device and is bound to the authenticated Access user by the Worker.
- Tasks and pull requests are shared across Devices.
- The CLI sends local metadata to the Worker after replacing the home-directory prefix in paths with `~`.

When implementing a service change, inspect the calling layer, persistence schema, and affected tests before editing. Keep unrelated relationship-ledger operations and deployment changes out of the product diff.
