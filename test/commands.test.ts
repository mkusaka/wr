import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { chmodSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  addPullRequest,
  addWorkpadLink,
  doneTask,
  findRunTerminal,
  listPullRequests,
  listRuns,
  listTasks,
  removePullRequest,
  show,
  startTask,
  syncPullRequests,
} from "../src/commands.ts";
import { tempDir, testContext, testDb } from "./helpers.ts";

let db: Database | null = null;
afterEach(() => db?.close());

describe("task lifecycle", () => {
  test("start is idempotent for the same task, session, and checkout", () => {
    db = testDb();
    const current = testContext(db, "session-1");
    const first = startTask(db, current, "TASK-1", { title: "first" });
    const second = startTask(db, current, "TASK-1", {});
    expect(second.executionId).toBe(first.executionId);
    expect(
      (db.query("SELECT COUNT(*) AS count FROM executions").get() as { count: number }).count,
    ).toBe(1);
  });

  test("done closes only the selected task and leaves another task untouched", () => {
    db = testDb();
    const session1 = testContext(db, "session-1");
    const session2 = testContext(db, "session-2");
    startTask(db, session1, "TASK-A", {});
    startTask(db, session1, "TASK-B", {});
    startTask(db, session2, "TASK-A", {});

    expect(doneTask(db, session1, "TASK-A")).toMatchObject({ finished: 1, abandoned: 1 });
    const rows = db
      .query(
        `SELECT t.linear_issue_id, e.status, cs.external_session_id
           FROM executions e JOIN tasks t ON t.id = e.task_id
           JOIN cli_sessions cs ON cs.id = e.cli_session_id
          ORDER BY t.linear_issue_id, cs.external_session_id`,
      )
      .all() as Array<{ linear_issue_id: string; status: string; external_session_id: string }>;
    expect(rows).toEqual([
      { linear_issue_id: "TASK-A", status: "finished", external_session_id: "session-1" },
      { linear_issue_id: "TASK-A", status: "abandoned", external_session_id: "session-2" },
      { linear_issue_id: "TASK-B", status: "active", external_session_id: "session-1" },
    ]);
  });

  test("repeated done succeeds and a later start reports reopen", () => {
    db = testDb();
    const current = testContext(db);
    startTask(db, current, "TASK-REOPEN", {});
    doneTask(db, current, "TASK-REOPEN");
    expect(doneTask(db, current, "TASK-REOPEN")).toMatchObject({ finished: 0, abandoned: 0 });
    expect(startTask(db, current, "TASK-REOPEN", {}).reopened).toBe(true);
  });

  test("an old active run is displayed as stale without being closed", () => {
    db = testDb();
    const current = testContext(db, "stale-session");
    db.query(
      "UPDATE session_runs SET last_seen_at = datetime('now', '-25 hours') WHERE id = $id",
    ).run({
      id: current.sessionRunId,
    });
    expect(listRuns(db, {})).toContain("[stale]");
    expect(
      (
        db
          .query("SELECT ended_at FROM session_runs WHERE id = $id")
          .get({ id: current.sessionRunId }) as { ended_at: null }
      ).ended_at,
    ).toBeNull();
  });

  test("lists tasks by status and most recent update", () => {
    db = testDb();
    const current = testContext(db);
    startTask(db, current, "TASK-OLD", { title: "Old" });
    startTask(db, current, "TASK-NEW", { title: "New" });
    db.query(
      "UPDATE tasks SET updated_at = '2026-01-01 00:00:00' WHERE linear_issue_id = 'TASK-OLD'",
    ).run();
    db.query(
      "UPDATE tasks SET updated_at = '2026-01-02 00:00:00' WHERE linear_issue_id = 'TASK-NEW'",
    ).run();
    const output = listTasks(db, { repoRoot: current.checkout!.repoRoot });
    expect(output.indexOf("TASK-NEW")).toBeLessThan(output.indexOf("TASK-OLD"));
    expect(listTasks(db, { status: "done" })).toBe("No tasks");
  });

  test("shows terminal liveness and resolves a focus target", () => {
    db = testDb();
    const current = testContext(db, "focus-session");
    db.query("UPDATE session_runs SET iterm_session_id = $terminal WHERE id = $id").run({
      id: current.sessionRunId,
      terminal: "w1t2p3:terminal-123",
    });
    expect(listRuns(db, {}, new Set(["terminal-123"]))).toContain("pane=live");
    expect(findRunTerminal(db, "focus-session")).toBe("terminal-123");
  });

  test("registers a workpad once and shows it in reverse lookup", () => {
    db = testDb();
    const current = testContext(db, "show-session");
    startTask(db, current, "TASK-SHOW", { title: "Show task" });
    const workpad = join(tempDir("wr-workpad"), "workpad.md");
    writeFileSync(workpad, "# Workpad\n");
    addWorkpadLink(db, current, workpad);
    addWorkpadLink(db, current, workpad);
    expect(
      (db.query("SELECT COUNT(*) AS count FROM task_links").get() as { count: number }).count,
    ).toBe(1);
    expect(show(db, current, {})).toContain(`workpad: ${realpathSync(workpad)}`);
    expect(show(db, null, { task: "TASK-SHOW" })).toContain("Execution active: codex:show-session");
  });
});

describe("PR registration", () => {
  test("stores a validated stack and warns about a branch mismatch", () => {
    db = testDb();
    const current = testContext(db);
    startTask(db, current, "TASK-PR", {});
    const bin = tempDir("wr-fake-gh");
    const gh = join(bin, "gh");
    writeFileSync(
      gh,
      `#!/bin/sh
if [ "$1 $2" = "repo view" ]; then
  echo '{"nameWithOwner":"owner/repo"}'
elif [ "$1 $2 $3" = "pr view 100" ]; then
  echo '{"number":100,"url":"https://example.test/100","headRefName":"parent-head","baseRefName":"main"}'
elif [ "$1 $2 $3" = "pr view 101" ]; then
  echo '{"number":101,"url":"https://example.test/101","headRefName":"child-head","baseRefName":"different-base"}'
else
  exit 1
fi
`,
    );
    chmodSync(gh, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}:${previousPath}`;
    try {
      const result = addPullRequest(db, current, 101, { task: "TASK-PR", parent: 100 });
      expect(result.repo).toBe("owner/repo");
      expect(result.warning).toContain("branch mismatch");
      const row = db
        .query(
          `SELECT child.number, parent.number AS parent_number
             FROM pull_requests child JOIN pull_requests parent ON parent.id = child.parent_pr_id
            WHERE child.number = 101`,
        )
        .get() as { number: number; parent_number: number };
      expect(row).toEqual({ number: 101, parent_number: 100 });
    } finally {
      process.env.PATH = previousPath;
    }
  });

  test("does not write pull request rows when gh fails", () => {
    db = testDb();
    const current = testContext(db);
    startTask(db, current, "TASK-PR", {});
    const bin = tempDir("wr-fake-gh");
    const gh = join(bin, "gh");
    writeFileSync(gh, "#!/bin/sh\nexit 1\n");
    chmodSync(gh, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}:${previousPath}`;
    try {
      expect(() => addPullRequest(db!, current, 999, { task: "TASK-PR" })).toThrow();
      expect(
        (db.query("SELECT COUNT(*) AS count FROM pull_requests").get() as { count: number }).count,
      ).toBe(0);
    } finally {
      process.env.PATH = previousPath;
    }
  });

  test("removes only the task relationship and lists remaining pull requests", () => {
    db = testDb();
    const current = testContext(db);
    startTask(db, current, "TASK-PR", {});
    const task = db.query("SELECT id FROM tasks WHERE linear_issue_id = 'TASK-PR'").get() as {
      id: string;
    };
    db.query(
      `INSERT INTO pull_requests
        (id, repo, number, url, head_branch, base_branch)
       VALUES ('pr-1', 'owner/repo', 42, 'https://example.test/42', 'feature', 'main')`,
    ).run();
    db.query(
      "INSERT INTO task_pull_requests (task_id, pull_request_id) VALUES ($taskId, 'pr-1')",
    ).run({ taskId: task.id });
    expect(listPullRequests(db, current.checkout!.repoRoot)).toContain("owner/repo#42");
    expect(listRuns(db, { repoRoot: current.checkout!.repoRoot, pullRequest: 42 })).toContain(
      "tasks=TASK-PR",
    );
    expect(
      listRuns(db, { repoRoot: current.checkout!.repoRoot, branch: current.checkout!.branch! }),
    ).toContain(`run=${current.sessionRunId}`);
    expect(listRuns(db, { worktreePath: current.checkout!.worktreePath })).toContain(
      `run=${current.sessionRunId}`,
    );
    expect(removePullRequest(db, null, 42, "TASK-PR")).toMatchObject({ removed: true });
    expect(
      (db.query("SELECT COUNT(*) AS count FROM pull_requests").get() as { count: number }).count,
    ).toBe(1);
    expect(listPullRequests(db)).toBe("No pull requests");
  });

  test("syncs pull requests for all active checkouts in the current session", () => {
    db = testDb();
    const current = testContext(db, "sync-session");
    startTask(db, current, "TASK-SYNC", {});
    const secondRepo = tempDir("wr-sync-second");
    expect(Bun.spawnSync(["git", "init", "-b", "feature"], { cwd: secondRepo }).exitCode).toBe(0);
    writeFileSync(join(secondRepo, ".sync-second"), "");
    startTask(db, current, "TASK-SYNC-SECOND", { worktree: secondRepo });
    const bin = tempDir("wr-fake-gh-sync");
    const gh = join(bin, "gh");
    writeFileSync(
      gh,
      `#!/bin/sh
if [ -f .sync-second ] && [ "$WR_FAKE_GH_FAIL_SECOND" = "1" ]; then
  exit 1
fi
if [ "$1 $2" = "repo view" ]; then
  echo '{"nameWithOwner":"owner/repo"}'
elif [ "$1 $2" = "pr list" ]; then
  if [ -f .sync-second ]; then
    echo '[{"number":78,"url":"https://example.test/78","headRefName":"feature","baseRefName":"main"}]'
  else
    echo '[{"number":77,"url":"https://example.test/77","headRefName":"main","baseRefName":"base"}]'
  fi
elif [ "$1 $2 $3" = "pr view 77" ]; then
  echo '{"number":77,"url":"https://example.test/77","headRefName":"main","baseRefName":"base"}'
elif [ "$1 $2 $3" = "pr view 78" ]; then
  echo '{"number":78,"url":"https://example.test/78","headRefName":"feature","baseRefName":"main"}'
else
  exit 1
fi
`,
    );
    chmodSync(gh, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}:${previousPath}`;
    try {
      process.env.WR_FAKE_GH_FAIL_SECOND = "1";
      expect(() => syncPullRequests(db!, current)).toThrow();
      expect(
        (db.query("SELECT COUNT(*) AS count FROM pull_requests").get() as { count: number }).count,
      ).toBe(0);
      delete process.env.WR_FAKE_GH_FAIL_SECOND;
      expect(syncPullRequests(db, current)).toMatchObject({
        checkouts: 2,
        pullRequests: 2,
        linked: 2,
      });
      expect(listPullRequests(db)).toContain("owner/repo#77");
      expect(listPullRequests(db)).toContain("owner/repo#78");
      expect(syncPullRequests(db, current)).toMatchObject({ pullRequests: 2, linked: 0 });
    } finally {
      delete process.env.WR_FAKE_GH_FAIL_SECOND;
      process.env.PATH = previousPath;
    }
  });
});
