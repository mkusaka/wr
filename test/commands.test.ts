import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { chmodSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as v from "valibot";
import {
  addPullRequest,
  addTask,
  addWorkpadLink,
  cancelTask,
  doneTask,
  findRunTerminal,
  removePullRequest,
  removeWorkpadLink,
  show,
  startTask,
  syncPullRequests,
} from "../src/commands.ts";
import { enableRepository } from "../src/config.ts";
import { queryResource } from "../src/resources.ts";
import {
  CountRowSchema,
  DbIntegerSchema,
  ExecutionStatusSchema,
  IdRowSchema,
  NonEmptyStringSchema,
} from "../src/validation.ts";
import { tempDir, testContext, testDb } from "./helpers.ts";

let db: Database | null = null;
afterEach(() => db?.close());

describe("task lifecycle", () => {
  test("adds an open task without creating an execution", () => {
    db = testDb();
    expect(addTask(db, "TASK-OPEN", "Open task")).toEqual({
      issue: "TASK-OPEN",
      status: "open",
    });
    expect(addTask(db, "TASK-OPEN", "Updated title")).toEqual({
      issue: "TASK-OPEN",
      status: "open",
    });
    expect(
      v.parse(CountRowSchema, db.query("SELECT COUNT(*) AS count FROM executions").get()).count,
    ).toBe(0);
    expect(queryResource(db, "tasks", { status: "open" })[0]).toEqual(
      expect.objectContaining({ linearIssueId: "TASK-OPEN", title: "Updated title" }),
    );
    const current = testContext(db, "open-task-session");
    expect(startTask(db, current, "TASK-OPEN", {}).reopened).toBe(false);
    expect(addTask(db, "TASK-OPEN")).toEqual({ issue: "TASK-OPEN", status: "active" });
    expect(
      v.parse(CountRowSchema, db.query("SELECT COUNT(*) AS count FROM executions").get()).count,
    ).toBe(1);
  });

  test("CLI adds an open task without a session environment", () => {
    db = testDb();
    const configHome = tempDir("wr-task-add-config");
    enableRepository(process.cwd(), { ...process.env, XDG_CONFIG_HOME: configHome });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      XDG_CONFIG_HOME: configHome,
      WR_DB_PATH: db.filename,
    };
    delete env.CODEX_THREAD_ID;
    delete env.WR_CLI_SESSION;

    const result = Bun.spawnSync(
      [process.execPath, "src/cli.ts", "task", "add", "TASK-CLI-OPEN", "--title", "Queued"],
      { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" },
    );
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString()).toContain("registered TASK-CLI-OPEN status=open");
    expect(
      v.parse(CountRowSchema, db.query("SELECT COUNT(*) AS count FROM executions").get()).count,
    ).toBe(0);
    const listed = Bun.spawnSync(
      [process.execPath, "src/cli.ts", "task", "list", "--global", "--status", "open"],
      { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" },
    );
    expect(listed.exitCode, listed.stderr.toString()).toBe(0);
    expect(listed.stdout.toString()).toContain("TASK-CLI-OPEN Queued");
  });

  test("start is idempotent for the same task, session, and checkout", () => {
    db = testDb();
    const current = testContext(db, "session-1");
    const first = startTask(db, current, "TASK-1", { title: "first" });
    const second = startTask(db, current, "TASK-1", {});
    expect(second.executionId).toBe(first.executionId);
    expect(
      v.parse(CountRowSchema, db.query("SELECT COUNT(*) AS count FROM executions").get()).count,
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
    const rows = v.parse(
      v.array(
        v.object({
          linear_issue_id: NonEmptyStringSchema,
          status: ExecutionStatusSchema,
          external_session_id: NonEmptyStringSchema,
        }),
      ),
      db
        .query(
          `SELECT t.linear_issue_id, e.status, cs.external_session_id
           FROM executions e JOIN tasks t ON t.id = e.task_id
           JOIN cli_sessions cs ON cs.id = e.cli_session_id
          ORDER BY t.linear_issue_id, cs.external_session_id`,
        )
        .all(),
    );
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

  test("cancel abandons only the selected task executions", () => {
    db = testDb();
    const session1 = testContext(db, "cancel-session-1");
    const session2 = testContext(db, "cancel-session-2");
    startTask(db, session1, "TASK-CANCEL", {});
    startTask(db, session2, "TASK-CANCEL", {});
    startTask(db, session1, "TASK-KEEP", {});

    expect(cancelTask(db, null, "TASK-CANCEL")).toEqual({
      issue: "TASK-CANCEL",
      abandoned: 2,
    });
    expect(
      db.query("SELECT status FROM tasks WHERE linear_issue_id = 'TASK-CANCEL'").get(),
    ).toEqual({ status: "cancelled" });
    expect(
      v.parse(
        v.object({ status: ExecutionStatusSchema }),
        db
          .query(
            `SELECT e.status FROM executions e JOIN tasks t ON t.id = e.task_id
              WHERE t.linear_issue_id = 'TASK-KEEP'`,
          )
          .get(),
      ).status,
    ).toBe("active");
    expect(cancelTask(db, null, "TASK-CANCEL").abandoned).toBe(0);
  });

  test("resolves a terminal focus target", () => {
    db = testDb();
    const current = testContext(db, "focus-session");
    db.query("UPDATE session_runs SET iterm_session_id = $terminal WHERE id = $id").run({
      id: current.sessionRunId,
      terminal: "w1t2p3:terminal-123",
    });
    expect(findRunTerminal(db, "focus-session")).toBe("terminal-123");
  });

  test("registers a workpad once and shows it in reverse lookup", () => {
    db = testDb();
    const current = testContext(db, "show-session");
    startTask(db, current, "TASK-SHOW", { title: "Show task" });
    const workpad = join(tempDir("wr-workpad"), "workpad.md");
    writeFileSync(workpad, "# Workpad\n");
    addWorkpadLink(db, current, workpad, "TASK-SHOW");
    addWorkpadLink(db, current, workpad, "TASK-SHOW");
    expect(
      v.parse(CountRowSchema, db.query("SELECT COUNT(*) AS count FROM task_links").get()).count,
    ).toBe(1);
    expect(show(db, current, {})).toContain(`workpad: ${realpathSync(workpad)}`);
    expect(show(db, null, { task: "TASK-SHOW" })).toContain("Execution active: codex:show-session");
    expect(JSON.parse(show(db, null, { task: "TASK-SHOW", json: true }))).toEqual([
      expect.objectContaining({
        linearIssueId: "TASK-SHOW",
        title: "Show task",
        status: "active",
        executions: [expect.objectContaining({ session: "codex:show-session", status: "active" })],
        links: [{ kind: "workpad", ref: realpathSync(workpad) }],
      }),
    ]);
    expect(removeWorkpadLink(db, current, workpad, "TASK-SHOW")).toEqual({
      issue: "TASK-SHOW",
      ref: realpathSync(workpad),
    });
    expect(() => removeWorkpadLink(db!, current, workpad, "TASK-SHOW")).toThrow(
      "Workpad is not linked",
    );
  });

  test("show does not include tasks from another session on the same checkout", () => {
    db = testDb();
    const working = testContext(db, "working-session");
    const empty = testContext(db, "empty-session");
    startTask(db, working, "TASK-OTHER-SESSION", {});

    expect(show(db, empty, {})).toBe("No related tasks");
    expect(show(db, empty, { json: true })).toBe("[]");
    expect(show(db, working, {})).toContain("Task TASK-OTHER-SESSION");
  });

  test("CLI show with an explicit session excludes another session on the same checkout", () => {
    db = testDb();
    const configHome = tempDir("wr-show-session-config");
    const working = testContext(db, "cli-working-session");
    testContext(db, "cli-empty-session");
    startTask(db, working, "TASK-CLI-OTHER-SESSION", {});
    enableRepository(process.cwd(), { ...process.env, XDG_CONFIG_HOME: configHome });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      XDG_CONFIG_HOME: configHome,
      WR_DB_PATH: db.filename,
    };
    delete env.CODEX_THREAD_ID;

    const result = Bun.spawnSync(
      [process.execPath, "src/cli.ts", "show", "--session", "cli-empty-session"],
      { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" },
    );
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString().trim()).toBe("No related tasks");

    const jsonResult = Bun.spawnSync(
      [process.execPath, "src/cli.ts", "show", "--session", "cli-empty-session", "--json"],
      { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" },
    );
    expect(jsonResult.exitCode, jsonResult.stderr.toString()).toBe(0);
    expect(JSON.parse(jsonResult.stdout.toString())).toEqual([]);
  });

  test("does not infer a task for workpads", () => {
    db = testDb();
    const current = testContext(db, "unassigned-workpad-session");
    const workpad = join(tempDir("wr-unassigned-workpad"), "workpad.md");
    writeFileSync(workpad, "# Workpad\n");

    expect(addWorkpadLink(db, current, workpad)).toEqual({
      issue: null,
      ref: realpathSync(workpad),
    });
    startTask(db, current, "TASK-FIRST", {});
    expect(addWorkpadLink(db, current, workpad).issue).toBeNull();
    expect(
      v.parse(
        CountRowSchema,
        db.query("SELECT COUNT(*) AS count FROM task_links WHERE task_id IS NULL").get(),
      ).count,
    ).toBe(1);
    expect(removeWorkpadLink(db, current, workpad)).toEqual({
      issue: null,
      ref: realpathSync(workpad),
    });
  });

  test("registers and removes a workpad identifier without a task", () => {
    db = testDb();
    const current = testContext(db, "identifier-workpad-session");

    expect(addWorkpadLink(db, current, "MOQ-1291")).toEqual({ issue: null, ref: "MOQ-1291" });
    expect(removeWorkpadLink(db, current, "MOQ-1291")).toEqual({
      issue: null,
      ref: "MOQ-1291",
    });
  });

  test("CLI cancels a task and removes a workpad relationship", () => {
    db = testDb();
    const configHome = tempDir("wr-command-config");
    const env = {
      ...process.env,
      CODEX_THREAD_ID: "command-session",
      XDG_CONFIG_HOME: configHome,
      WR_DB_PATH: db.filename,
    };
    enableRepository(process.cwd(), env);
    const workpad = join(tempDir("wr-command-workpad"), "workpad.md");
    writeFileSync(workpad, "# Workpad\n");
    for (const args of [
      ["task", "start", "TASK-COMMAND"],
      ["link", "workpad", "add", workpad, "--task", "TASK-COMMAND"],
      ["link", "workpad", "remove", workpad, "--task", "TASK-COMMAND"],
      ["link", "workpad", "LEGACY-WORKPAD", "--task", "TASK-COMMAND"],
      ["link", "remove", "workpad", "LEGACY-WORKPAD", "--task", "TASK-COMMAND"],
      ["task", "cancel", "TASK-COMMAND"],
    ]) {
      const result = Bun.spawnSync([process.execPath, "src/cli.ts", ...args], {
        cwd: process.cwd(),
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
    }
    expect(
      db.query("SELECT status FROM tasks WHERE linear_issue_id = 'TASK-COMMAND'").get(),
    ).toEqual({ status: "cancelled" });
    expect(
      v.parse(CountRowSchema, db.query("SELECT COUNT(*) AS count FROM task_links").get()).count,
    ).toBe(0);
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
      const row = v.parse(
        v.object({ number: DbIntegerSchema, parent_number: DbIntegerSchema }),
        db
          .query(
            `SELECT child.number, parent.number AS parent_number
             FROM pull_requests child JOIN pull_requests parent ON parent.id = child.parent_pr_id
            WHERE child.number = 101`,
          )
          .get(),
      );
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
        v.parse(CountRowSchema, db.query("SELECT COUNT(*) AS count FROM pull_requests").get())
          .count,
      ).toBe(0);
    } finally {
      process.env.PATH = previousPath;
    }
  });

  test("does not infer a task for pull requests", () => {
    db = testDb();
    const current = testContext(db);
    const bin = tempDir("wr-fake-gh-unlinked");
    const gh = join(bin, "gh");
    writeFileSync(
      gh,
      `#!/bin/sh
if [ "$1 $2" = "repo view" ]; then
  echo '{"nameWithOwner":"owner/repo"}'
elif [ "$1 $2 $3" = "pr view 201" ]; then
  echo '{"number":201,"url":"https://example.test/201","headRefName":"first","baseRefName":"main"}'
elif [ "$1 $2 $3" = "pr view 202" ]; then
  echo '{"number":202,"url":"https://example.test/202","headRefName":"second","baseRefName":"main"}'
elif [ "$1 $2 $3" = "pr view 203" ]; then
  echo '{"number":203,"url":"https://example.test/203","headRefName":"third","baseRefName":"main"}'
else
  exit 1
fi
`,
    );
    chmodSync(gh, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}:${previousPath}`;
    try {
      addPullRequest(db, current, 201, {});
      startTask(db, current, "TASK-ONE", {});
      addPullRequest(db, current, 202, {});
      startTask(db, current, "TASK-TWO", {});
      addPullRequest(db, current, 203, {});
      expect(
        v.parse(CountRowSchema, db.query("SELECT COUNT(*) AS count FROM pull_requests").get())
          .count,
      ).toBe(3);
      expect(
        v.parse(CountRowSchema, db.query("SELECT COUNT(*) AS count FROM task_pull_requests").get())
          .count,
      ).toBe(0);
      expect(
        v.parse(
          CountRowSchema,
          db.query("SELECT COUNT(*) AS count FROM session_run_pull_requests").get(),
        ).count,
      ).toBe(3);
    } finally {
      process.env.PATH = previousPath;
    }
  });

  test("removes only the task relationship", () => {
    db = testDb();
    const current = testContext(db);
    startTask(db, current, "TASK-PR", {});
    const task = v.parse(
      IdRowSchema,
      db.query("SELECT id FROM tasks WHERE linear_issue_id = 'TASK-PR'").get(),
    );
    db.query(
      `INSERT INTO pull_requests
        (id, repo, number, url, head_branch, base_branch)
       VALUES ('pr-1', 'owner/repo', 42, 'https://example.test/42', 'feature', 'main')`,
    ).run();
    db.query(
      "INSERT INTO task_pull_requests (task_id, pull_request_id) VALUES ($taskId, 'pr-1')",
    ).run({ taskId: task.id });
    expect(removePullRequest(db, 42, "TASK-PR")).toMatchObject({ removed: true });
    expect(
      v.parse(CountRowSchema, db.query("SELECT COUNT(*) AS count FROM pull_requests").get()).count,
    ).toBe(1);
  });

  test("syncs pull requests for all active checkouts in the current session", () => {
    db = testDb();
    const current = testContext(db, "sync-session");
    startTask(db, current, "TASK-SYNC", {});
    startTask(db, current, "TASK-SYNC-AMBIGUOUS", {});
    const secondRepo = tempDir("wr-sync-second");
    expect(Bun.spawnSync(["git", "init", "-b", "feature"], { cwd: secondRepo }).exitCode).toBe(0);
    writeFileSync(join(secondRepo, ".sync-second"), "");
    startTask(db, current, "TASK-SYNC-SECOND", { worktree: secondRepo });
    expect(
      v.parse(
        CountRowSchema,
        db
          .query(
            "SELECT COUNT(*) AS count FROM session_run_checkouts WHERE session_run_id = $runId",
          )
          .get({ runId: current.sessionRunId }),
      ).count,
    ).toBe(2);
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
        v.parse(CountRowSchema, db.query("SELECT COUNT(*) AS count FROM pull_requests").get())
          .count,
      ).toBe(0);
      delete process.env.WR_FAKE_GH_FAIL_SECOND;
      expect(syncPullRequests(db, current)).toMatchObject({
        checkouts: 2,
        pullRequests: 2,
        linked: 0,
      });
      expect(
        v.parse(CountRowSchema, db.query("SELECT COUNT(*) AS count FROM task_pull_requests").get())
          .count,
      ).toBe(0);
      expect(
        v.parse(
          CountRowSchema,
          db.query("SELECT COUNT(*) AS count FROM session_run_pull_requests").get(),
        ).count,
      ).toBe(2);
      expect(syncPullRequests(db, current)).toMatchObject({ pullRequests: 2, linked: 0 });
      expect(
        v.parse(
          CountRowSchema,
          db.query("SELECT COUNT(*) AS count FROM session_run_pull_requests").get(),
        ).count,
      ).toBe(2);
    } finally {
      delete process.env.WR_FAKE_GH_FAIL_SECOND;
      process.env.PATH = previousPath;
    }
  });
});
