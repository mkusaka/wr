import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import * as v from "valibot";
import schema from "./schema.sql" with { type: "text" };
import { CountRowSchema, DbIntegerSchema, NonEmptyStringSchema } from "./validation.ts";

const SCHEMA_VERSION = 5;

export function defaultDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const dataHome = env.XDG_DATA_HOME || (env.HOME ? join(env.HOME, ".local", "share") : undefined);
  if (!dataHome) throw new Error("HOME or XDG_DATA_HOME is required");
  return join(dataHome, "wr", "wr.db");
}

export function openDb(path = defaultDbPath()): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.run("PRAGMA busy_timeout = 5000");
  db.run("PRAGMA foreign_keys = ON");

  const journal = v.parse(
    v.object({ journal_mode: NonEmptyStringSchema }),
    db.query("PRAGMA journal_mode").get(),
  );
  if (path !== ":memory:" && journal.journal_mode !== "wal") db.run("PRAGMA journal_mode = WAL");

  const readVersion = () => {
    const row = v.parse(
      v.nullable(v.object({ user_version: DbIntegerSchema })),
      db.query("PRAGMA user_version").get(),
    );
    return Number(row?.user_version ?? 0);
  };
  const hasTables = () => {
    const row = v.parse(
      v.nullable(CountRowSchema),
      db
        .query(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        )
        .get(),
    );
    return Number(row?.count ?? 0) > 0;
  };

  let version = readVersion();
  if (version === 0 && !hasTables()) {
    db.transaction(() => {
      version = readVersion();
      if (version === 0 && !hasTables()) {
        db.run(schema);
        db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
        version = SCHEMA_VERSION;
      }
    }).immediate();
  }
  if (version !== SCHEMA_VERSION) {
    db.close();
    throw new Error(`Unsupported database schema version: ${version}`);
  }

  return db;
}

export function newId(): string {
  return crypto.randomUUID();
}
