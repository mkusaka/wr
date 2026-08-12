import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import * as v from "valibot";
import { openDb } from "../src/db.ts";
import { CountRowSchema, DbIntegerSchema, NonEmptyStringSchema } from "../src/validation.ts";
import { tempDir } from "./helpers.ts";

let db: Database | null = null;
afterEach(() => db?.close());

describe("database", () => {
  test("initializes the schema and connection pragmas", () => {
    db = openDb(join(tempDir("wr-db"), "wr.db"));
    const version = v.parse(
      v.object({ user_version: DbIntegerSchema }),
      db.query("PRAGMA user_version").get(),
    );
    const journal = v.parse(
      v.object({ journal_mode: NonEmptyStringSchema }),
      db.query("PRAGMA journal_mode").get(),
    );
    const foreignKeys = v.parse(
      v.object({ foreign_keys: DbIntegerSchema }),
      db.query("PRAGMA foreign_keys").get(),
    );
    const indexes = v.parse(
      v.array(v.object({ name: NonEmptyStringSchema })),
      db
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name",
        )
        .all(),
    );

    expect(version.user_version).toBe(3);
    expect(journal.journal_mode).toBe("wal");
    expect(foreignKeys.foreign_keys).toBe(1);
    expect(indexes.map((row) => row.name)).toEqual([
      "idx_checkouts_repo",
      "idx_exec_active_checkout",
      "idx_exec_active_task",
      "idx_run_checkouts_checkout",
      "idx_runs_active_terminal",
      "idx_task_links_checkout_ref",
      "idx_task_links_task_ref",
    ]);
  });

  test("reopens a version 3 database", () => {
    const path = join(tempDir("wr-db"), "wr.db");
    db = openDb(path);
    db.close();
    db = openDb(path);
    expect(
      v.parse(CountRowSchema, db.query("SELECT COUNT(*) AS count FROM tasks").get()).count,
    ).toBe(0);
  });

  test("rejects an unknown schema version without changing it", () => {
    const path = join(tempDir("wr-db"), "wr.db");
    db = openDb(path);
    db.run("PRAGMA user_version = 9");
    db.close();
    db = null;
    expect(() => openDb(path)).toThrow("Unsupported database schema version: 9");
  });

  test("does not migrate a version 2 database", () => {
    const path = join(tempDir("wr-db"), "wr.db");
    db = openDb(path);
    db.run("PRAGMA user_version = 2");
    db.close();
    db = null;
    expect(() => openDb(path)).toThrow("Unsupported database schema version: 2");
  });

  test("rejects a foreign key violation", () => {
    db = openDb(":memory:");
    expect(() =>
      db!
        .query(
          "INSERT INTO executions (id, task_id, cli_session_id) VALUES ('e', 'missing-task', 'missing-session')",
        )
        .run(),
    ).toThrow();
  });
});
