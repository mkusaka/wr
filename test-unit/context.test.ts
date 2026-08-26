import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  clearDevinSession,
  findCurrentSession,
  normalizeStoredPath,
  parseHookPayload,
  parseToolHookPayload,
  writeDevinSession,
} from "../src/context.ts";

describe("stored paths", () => {
  test.each([
    ["/Users/example", "~"],
    ["/Users/example/src/github.com/example/wr", "~/src/github.com/example/wr"],
    ["/Users/example-other/src", "/Users/example-other/src"],
    ["/tmp/workpad.md", "/tmp/workpad.md"],
  ])("normalizes %s", (path, expected) => {
    expect(normalizeStoredPath(path, "/Users/example")).toBe(expected);
  });
});

describe("session discovery", () => {
  test.each([
    [{ PI_SESSION_ID: "pi-session" }, { cli: "pi", externalSessionId: "pi-session" }],
    [{ DEVIN_SESSION_ID: "polite-axolotl" }, { cli: "devin", externalSessionId: "polite-axolotl" }],
    [{ WR_CLI_SESSION: "devin:calm-otter" }, { cli: "devin", externalSessionId: "calm-otter" }],
  ] as const)("detects %s", (env, expected) => {
    expect(findCurrentSession(undefined, env)).toEqual(expected);
  });

  test("prefers the Pi session for commands run by Pi", () => {
    expect(
      findCurrentSession(undefined, {
        PI_SESSION_ID: "pi-session",
        CODEX_THREAD_ID: "codex-thread",
      }),
    ).toEqual({ cli: "pi", externalSessionId: "pi-session" });
  });

  test("fills Devin hook payload cwd from the project directory", () => {
    expect(
      parseHookPayload(
        JSON.stringify({ session_id: "polite-axolotl", source: "startup" }),
        "/Users/example/project",
      ),
    ).toEqual({
      session_id: "polite-axolotl",
      source: "startup",
      cwd: "/Users/example/project",
    });
  });

  test("rejects a hook payload without cwd when no default is provided", () => {
    expect(() => parseHookPayload(JSON.stringify({ session_id: "polite-axolotl" }))).toThrow(
      "Invalid hook payload",
    );
  });

  test("fills Devin tool hook payload cwd from the project directory", () => {
    expect(
      parseToolHookPayload(
        JSON.stringify({
          session_id: "polite-axolotl",
          tool_name: "exec",
          tool_input: { command: "gh pr create" },
          tool_response: { success: true, output: "created" },
        }),
        "/Users/example/project",
      ),
    ).toEqual({
      session_id: "polite-axolotl",
      cwd: "/Users/example/project",
      tool_name: "exec",
      tool_input: { command: "gh pr create" },
      tool_response: { success: true, output: "created" },
    });
  });
});

describe("Devin session resolution", () => {
  const originalXdg = process.env.XDG_STATE_HOME;
  const originalChisel = process.env.CHISEL_SESSION_DB;
  const tmpDir = `/tmp/wr-context-test-${Date.now()}`;

  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true });
    process.env.XDG_STATE_HOME = tmpDir;
    process.env.CHISEL_SESSION_DB = join(tmpDir, "nonexistent", "sessions.db");
    process.env.WR_DEVIN_PROCESS_PID = String(process.pid);
    delete process.env.WR_SESSION_RUN_ID;
    delete process.env.DEVIN_PROJECT_DIR;
    rmSync(join(tmpDir, "wr", "devin-sessions.json"), { force: true });
  });

  afterEach(() => {
    process.env.XDG_STATE_HOME = originalXdg;
    process.env.CHISEL_SESSION_DB = originalChisel;
    delete process.env.WR_DEVIN_PROCESS_PID;
    delete process.env.WR_SESSION_RUN_ID;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("finds a persisted Devin session by Devin process pid", () => {
    const projectDir = "/Users/example/project";
    const devinPid = process.pid;
    writeDevinSession(
      { cli: "devin", externalSessionId: "polite-axolotl" },
      "run-1",
      projectDir,
      devinPid,
    );
    const session = findCurrentSession(undefined, process.env, projectDir);
    expect(session).toEqual({ cli: "devin", externalSessionId: "polite-axolotl" });
    expect(process.env.WR_SESSION_RUN_ID).toBe("run-1");
  });

  test("falls back to Devin sessions.db when state file has no matching pid", () => {
    const projectDir = "/Users/example/project";
    const dbPath = join(tmpDir, "sessions.db");
    process.env.CHISEL_SESSION_DB = dbPath;
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        working_directory TEXT NOT NULL,
        hidden INTEGER NOT NULL DEFAULT 0,
        last_activity_at INTEGER NOT NULL
      );
    `);
    const insert = db.query(
      "INSERT INTO sessions (id, working_directory, hidden, last_activity_at) VALUES (?, ?, 0, ?)",
    );
    insert.run("calm-otter", "/Users/example/other", 100);
    insert.run("polite-axolotl", projectDir, 200);
    insert.run("stale-hippo", projectDir, 100);
    insert.finalize();
    db.close();

    const session = findCurrentSession(undefined, process.env, projectDir);
    expect(session).toEqual({ cli: "devin", externalSessionId: "polite-axolotl" });
  });

  test("ignores a stale Devin session from another project in the db", () => {
    const dbPath = join(tmpDir, "sessions.db");
    process.env.CHISEL_SESSION_DB = dbPath;
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        working_directory TEXT NOT NULL,
        hidden INTEGER NOT NULL DEFAULT 0,
        last_activity_at INTEGER NOT NULL
      );
    `);
    db.query(
      "INSERT INTO sessions (id, working_directory, hidden, last_activity_at) VALUES (?, ?, 0, ?)",
    ).run("calm-otter", "/Users/example/a", 200);
    db.close();

    const session = findCurrentSession(undefined, process.env, "/Users/example/b");
    expect(session).toBeNull();
  });

  test("clears the state file for the matching session", () => {
    const devinPid = process.pid;
    writeDevinSession(
      { cli: "devin", externalSessionId: "polite-axolotl" },
      "run-1",
      "/Users/example/project",
      devinPid,
    );
    clearDevinSession("other-session");
    expect(findCurrentSession(undefined, process.env, "/Users/example/project")).not.toBeNull();
    clearDevinSession("polite-axolotl");
    expect(findCurrentSession(undefined, process.env, "/Users/example/project")).toBeNull();
  });
});
