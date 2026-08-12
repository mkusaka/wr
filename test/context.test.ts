import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { discoverCheckout } from "../src/git.ts";
import {
  endSession,
  parseHookPayload,
  registerSessionEvent,
  resolveCurrentContext,
} from "../src/context.ts";
import { tempDir, testDb } from "./helpers.ts";

let db: Database | null = null;
afterEach(() => db?.close());

describe("session context", () => {
  test("supersedes the previous active run in the same terminal", () => {
    db = testDb();
    const env = { TERM_SESSION_ID: "term-1" };
    const first = registerSessionEvent(
      db,
      "codex",
      { session_id: "one", cwd: process.cwd(), source: "startup" },
      env,
    );
    const second = registerSessionEvent(
      db,
      "codex",
      { session_id: "two", cwd: process.cwd(), source: "resume" },
      env,
    );
    const firstRow = db
      .query("SELECT ended_at, end_reason FROM session_runs WHERE id = $id")
      .get({ id: first.sessionRunId }) as {
      ended_at: string;
      end_reason: string;
    };
    expect(firstRow.ended_at).not.toBeNull();
    expect(firstRow.end_reason).toBe("superseded");
    expect(
      (
        db.query("SELECT COUNT(*) AS count FROM session_runs WHERE ended_at IS NULL").get() as {
          count: number;
        }
      ).count,
    ).toBe(1);
    expect(second.sessionRunId).not.toBe(first.sessionRunId);
  });

  test("repeated compact events update the same run and environment file", () => {
    db = testDb();
    const envFile = join(tempDir("wr-env"), "env");
    const env = { TERM_SESSION_ID: "term-compact", CLAUDE_ENV_FILE: envFile };
    const start = registerSessionEvent(
      db,
      "claude",
      { session_id: "claude-1", cwd: process.cwd(), source: "startup" },
      env,
    );
    const compact1 = registerSessionEvent(
      db,
      "claude",
      { session_id: "claude-1", cwd: process.cwd(), source: "compact" },
      env,
    );
    const compact2 = registerSessionEvent(
      db,
      "claude",
      { session_id: "claude-1", cwd: process.cwd(), source: "compact" },
      env,
    );
    expect(compact1.sessionRunId).toBe(start.sessionRunId);
    expect(compact2.sessionRunId).toBe(start.sessionRunId);
    expect(
      (db.query("SELECT COUNT(*) AS count FROM session_runs").get() as { count: number }).count,
    ).toBe(1);
    expect(Bun.file(envFile).text()).resolves.toContain(
      `WR_SESSION_RUN_ID='${start.sessionRunId}'`,
    );
  });

  test("session end without TERM_SESSION_ID closes the latest session run", () => {
    db = testDb();
    const started = registerSessionEvent(
      db,
      "claude",
      { session_id: "claude-end", cwd: process.cwd(), source: "startup" },
      {},
    );
    expect(endSession(db, "claude", { session_id: "claude-end", cwd: process.cwd() }, {})).toBe(
      started.sessionRunId,
    );
    const row = db
      .query("SELECT end_reason FROM session_runs WHERE id = $id")
      .get({ id: started.sessionRunId }) as {
      end_reason: string;
    };
    expect(row.end_reason).toBe("session_end");
  });

  test("self-registers a session and rejects an explicit conflict", () => {
    db = testDb();
    const current = resolveCurrentContext(db, process.cwd(), undefined, {
      CODEX_THREAD_ID: "self-register",
    });
    expect(current.externalSessionId).toBe("self-register");
    expect(current.sessionRunId).toBeTruthy();
    expect(() =>
      resolveCurrentContext(db!, process.cwd(), "claude:other", {
        CODEX_THREAD_ID: "self-register",
      }),
    ).toThrow("conflicts");
  });

  test("validates hook payloads with Valibot", () => {
    expect(parseHookPayload('{"session_id":"id","cwd":"/tmp","source":"startup"}')).toEqual({
      session_id: "id",
      cwd: "/tmp",
      source: "startup",
    });
    expect(() => parseHookPayload('{"session_id":1,"cwd":"/tmp"}')).toThrow(
      "Hook payload is invalid",
    );
  });
});

describe("git discovery", () => {
  test("gets the main repository root from worktree metadata", () => {
    const checkout = discoverCheckout(process.cwd(), true)!;
    const worktrees = Bun.spawnSync(["git", "worktree", "list", "--porcelain"], {
      cwd: process.cwd(),
    });
    const mainWorktree = worktrees.stdout.toString().split("\n", 1)[0]!.slice("worktree ".length);
    const branch = Bun.spawnSync(["git", "branch", "--show-current"], {
      cwd: process.cwd(),
    })
      .stdout.toString()
      .trim();
    expect(checkout.worktreePath).toBe(process.cwd());
    expect(checkout.repoRoot).toBe(realpathSync(mainWorktree));
    expect(checkout.branch).toBe(branch);
  });

  test("normalizes a symlink path with realpath", () => {
    const base = tempDir("wr-link");
    const link = join(base, "checkout");
    symlinkSync(process.cwd(), link);
    expect(discoverCheckout(link, true)?.worktreePath).toBe(process.cwd());
  });

  test("returns null outside Git unless discovery is required", () => {
    const outside = tempDir("wr-outside");
    expect(discoverCheckout(outside)).toBeNull();
    expect(() => discoverCheckout(outside, true)).toThrow();
  });
});
