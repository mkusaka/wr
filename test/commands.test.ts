import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { chmodSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  addPullRequest,
  addWorkpadLink,
  doneTask,
  listSessions,
  show,
  startTask,
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
    expect(listSessions(db)).toContain("[stale]");
    expect(
      (
        db
          .query("SELECT ended_at FROM session_runs WHERE id = $id")
          .get({ id: current.sessionRunId }) as { ended_at: null }
      ).ended_at,
    ).toBeNull();
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
});
