import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { tempDir } from "./helpers.ts";

let db: Database | null = null;
afterEach(() => db?.close());

describe("database", () => {
  test("initializes the schema and connection pragmas", () => {
    db = openDb(join(tempDir("wr-db"), "wr.db"));
    const version = db.query("PRAGMA user_version").get() as { user_version: number };
    const journal = db.query("PRAGMA journal_mode").get() as { journal_mode: string };
    const foreignKeys = db.query("PRAGMA foreign_keys").get() as { foreign_keys: number };
    const indexes = db
      .query(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>;

    expect(version.user_version).toBe(2);
    expect(journal.journal_mode).toBe("wal");
    expect(foreignKeys.foreign_keys).toBe(1);
    expect(indexes.map((row) => row.name)).toEqual([
      "idx_checkouts_repo",
      "idx_exec_active_checkout",
      "idx_exec_active_task",
      "idx_run_checkouts_checkout",
      "idx_runs_active_terminal",
    ]);
  });

  test("reopens a version 2 database", () => {
    const path = join(tempDir("wr-db"), "wr.db");
    db = openDb(path);
    db.close();
    db = openDb(path);
    expect((db.query("SELECT COUNT(*) AS count FROM tasks").get() as { count: number }).count).toBe(
      0,
    );
  });

  test("rejects an unknown schema version without changing it", () => {
    const path = join(tempDir("wr-db"), "wr.db");
    db = openDb(path);
    db.run("PRAGMA user_version = 9");
    db.close();
    db = null;
    expect(() => openDb(path)).toThrow("Unsupported database schema version: 9");
  });

  test("does not migrate a version 1 database", () => {
    const path = join(tempDir("wr-db"), "wr.db");
    db = openDb(path);
    db.run("PRAGMA user_version = 1");
    db.close();
    db = null;
    expect(() => openDb(path)).toThrow("Unsupported database schema version: 1");
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
