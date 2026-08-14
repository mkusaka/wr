import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as v from "valibot";
import { startTask } from "../src/commands.ts";
import { resolveCurrentContext } from "../src/context.ts";
import { renderResource } from "../src/output.ts";
import { queryResource, type ResourceName } from "../src/resources.ts";
import { IdRowSchema } from "../src/validation.ts";
import { tempDir, testContext, testDb } from "./helpers.ts";

let db: Database | null = null;
afterEach(() => db?.close());

function relatedRecords() {
  db = testDb();
  const current = testContext(db, "resource-session");
  const started = startTask(db, current, "MAL-123", { title: "Related records" });
  const task = v.parse(
    IdRowSchema,
    db.query("SELECT id FROM tasks WHERE linear_issue_id = 'MAL-123'").get(),
  );
  db.query(
    `INSERT INTO task_links (id, task_id, checkout_id, kind, ref)
     VALUES ('link-1', $taskId, $checkoutId, 'workpad', '/tmp/workpad.md')`,
  ).run({ taskId: task.id, checkoutId: current.checkoutId });
  db.query(
    `INSERT INTO pull_requests
       (id, repo, number, url, head_branch, base_branch, state)
     VALUES ('pr-1', 'owner/repo', 123, 'https://example.test/123', 'feature', 'main', 'open')`,
  ).run();
  db.query(
    `INSERT INTO task_pull_requests (task_id, pull_request_id)
     VALUES ($taskId, 'pr-1')`,
  ).run({ taskId: task.id });
  db.query("UPDATE git_checkouts SET branch = 'feature' WHERE id = $id").run({
    id: current.checkoutId,
  });
  return { current, executionId: started.executionId };
}

describe("resource queries", () => {
  test("queries every resource from a Linear issue", () => {
    relatedRecords();
    const resources: ResourceName[] = [
      "tasks",
      "sessions",
      "runs",
      "checkouts",
      "executions",
      "links",
      "prs",
      "branches",
      "terminals",
      "repos",
    ];
    for (const resource of resources) {
      expect(queryResource(db!, resource, { task: "MAL-123" })).toHaveLength(1);
    }
    expect(queryResource(db!, "sessions", { task: "MAL-123" })[0]?.session).toBe(
      "codex:resource-session",
    );
    expect(queryResource(db!, "prs", { task: "MAL-123" })[0]?.linearIssueId).toBe("MAL-123");
    expect(queryResource(db!, "prs", { status: "open" })[0]?.state).toBe("open");
    expect(queryResource(db!, "prs", { status: "closed" })).toEqual([]);
  });

  test("uses each linked entity as a reverse-lookup origin", () => {
    const { current, executionId } = relatedRecords();
    const filters = [
      { session: "resource-session" },
      { run: current.sessionRunId },
      { checkout: current.checkoutId! },
      { execution: executionId },
      { link: "link-1" },
      { terminal: "term-resource-session" },
      { repoRoot: current.checkout!.repoRoot },
      { worktreePath: current.checkout!.worktreePath },
      { branch: "feature" },
      { pullRequest: 123 },
    ];
    for (const filter of filters) {
      expect(queryResource(db!, "tasks", filter)[0]?.linearIssueId).toBe("MAL-123");
    }
  });

  test("uses the same canonical identity for Claude and Codex sessions", () => {
    db = testDb();
    resolveCurrentContext(db, process.cwd(), undefined, {
      WR_CLI_SESSION: "claude:claude-session",
    });
    expect(resolveCurrentContext(db, process.cwd(), "claude-session", {}).cli).toBe("claude");
    expect(queryResource(db, "sessions", { session: "claude-session" })[0]?.session).toBe(
      "claude:claude-session",
    );
  });

  test("finds a run and checkout by repository before an execution exists", () => {
    db = testDb();
    const current = testContext(db, "run-checkout-session");
    const filter = { repoRoot: current.checkout!.repoRoot };
    expect(queryResource(db, "runs", filter)[0]?.id).toBe(current.sessionRunId);
    expect(queryResource(db, "sessions", filter)[0]?.externalSessionId).toBe(
      "run-checkout-session",
    );
    expect(queryResource(db, "checkouts", { session: "run-checkout-session" })[0]?.id).toBe(
      current.checkoutId,
    );
    expect(queryResource(db, "executions", filter)).toEqual([]);
  });

  test("finds an unassigned workpad from its checkout and repository", () => {
    db = testDb();
    const current = testContext(db, "unassigned-link-session");
    db.query(
      `INSERT INTO task_links (id, task_id, checkout_id, kind, ref)
       VALUES ('unassigned-link', NULL, $checkoutId, 'workpad', '/tmp/unassigned.md')`,
    ).run({ checkoutId: current.checkoutId });

    expect(queryResource(db, "links", {})[0]).toEqual(
      expect.objectContaining({
        id: "unassigned-link",
        linearIssueId: null,
        worktreePath: current.checkout!.worktreePath,
      }),
    );
    expect(queryResource(db, "links", { repoRoot: current.checkout!.repoRoot })).toHaveLength(1);
    expect(
      queryResource(db, "links", { worktreePath: current.checkout!.worktreePath }),
    ).toHaveLength(1);
    expect(queryResource(db, "checkouts", { link: "unassigned-link" })[0]?.id).toBe(
      current.checkoutId,
    );
  });

  test("finds an unassigned pull request from its session run and checkout", () => {
    db = testDb();
    const current = testContext(db, "unassigned-pr-session");
    db.query("UPDATE git_checkouts SET branch = 'feature' WHERE id = $id").run({
      id: current.checkoutId,
    });
    db.query(
      `INSERT INTO pull_requests
         (id, repo, number, url, head_branch, base_branch)
       VALUES ('unassigned-pr', 'owner/repo', 725, 'https://example.test/725', 'feature', 'main')`,
    ).run();
    db.query(
      `INSERT INTO session_run_pull_requests
         (session_run_id, checkout_id, pull_request_id)
       VALUES ($runId, $checkoutId, 'unassigned-pr')`,
    ).run({ runId: current.sessionRunId, checkoutId: current.checkoutId });

    for (const filter of [
      { session: "unassigned-pr-session" },
      { run: current.sessionRunId },
      { checkout: current.checkoutId! },
      { repoRoot: current.checkout!.repoRoot },
      { worktreePath: current.checkout!.worktreePath },
      { branch: "feature" },
      { pullRequest: 725 },
    ]) {
      expect(queryResource(db, "prs", filter)[0]).toEqual(
        expect.objectContaining({ number: 725, linearIssueId: null }),
      );
    }
    expect(queryResource(db, "sessions", { pullRequest: 725 })[0]?.externalSessionId).toBe(
      "unassigned-pr-session",
    );
    expect(queryResource(db, "runs", { pullRequest: 725 })[0]?.id).toBe(current.sessionRunId);
    expect(queryResource(db, "checkouts", { pullRequest: 725 })[0]?.id).toBe(current.checkoutId);
    expect(queryResource(db, "branches", { pullRequest: 725 })[0]?.branch).toBe("feature");
    expect(queryResource(db, "terminals", { pullRequest: 725 })[0]?.runId).toBe(
      current.sessionRunId,
    );
    expect(queryResource(db, "repos", { pullRequest: 725 })[0]?.repoRoot).toBe(
      current.checkout!.repoRoot,
    );
    expect(queryResource(db, "tasks", { pullRequest: 725 })).toEqual([]);
  });

  test("orders tasks by most recent update", () => {
    const { current } = relatedRecords();
    startTask(db!, current, "MAL-OLD", {});
    db!.query("UPDATE tasks SET updated_at = '2026-01-01' WHERE linear_issue_id = 'MAL-123'").run();
    db!.query("UPDATE tasks SET updated_at = '2025-01-01' WHERE linear_issue_id = 'MAL-OLD'").run();
    expect(queryResource(db!, "tasks", {})[0]?.linearIssueId).toBe("MAL-123");
  });

  test("summarizes repositories and limits ordered resources", () => {
    const { current } = relatedRecords();
    const repositories = queryResource(db!, "repos", {});
    expect(repositories).toEqual([
      expect.objectContaining({
        repoRoot: current.checkout!.repoRoot,
        status: "active",
        worktreeCount: 1,
        taskCount: 1,
        activeExecutions: 1,
      }),
    ]);
    startTask(db!, current, "MAL-SECOND", {});
    expect(queryResource(db!, "tasks", { limit: 1 })).toHaveLength(1);
    expect(queryResource(db!, "repos", { status: "inactive" })).toHaveLength(0);
  });
});

describe("resource output", () => {
  test("projects validated JSON fields", () => {
    const rows = [{ linearIssueId: "MAL-123", status: "active", title: "Task" }];
    expect(renderResource("tasks", rows, "linearIssueId,status")).toBe(
      '[\n  {\n    "linearIssueId": "MAL-123",\n    "status": "active"\n  }\n]',
    );
    expect(() => renderResource("tasks", rows, "unknown")).toThrow(
      "Unknown JSON field for tasks: unknown",
    );
  });

  test("groups human-readable tasks by status", () => {
    const output = renderResource("tasks", [
      { linearIssueId: "MAL-1", status: "done", title: "Done", updatedAt: "2026-01-01" },
      { linearIssueId: "MAL-2", status: "active", title: "Active", updatedAt: "2026-01-02" },
      { linearIssueId: "MAL-3", status: "open", title: "Open", updatedAt: "2026-01-03" },
    ]);
    expect(output.indexOf("open:")).toBeLessThan(output.indexOf("active:"));
    expect(output.indexOf("active:")).toBeLessThan(output.indexOf("done:"));
    expect(output).toContain("MAL-3 Open updated=2026-01-03");
    expect(output).toContain("MAL-2 Active updated=2026-01-02");
  });

  test("passes JSON output through jq", () => {
    const bin = tempDir("wr-fake-jq");
    const jq = join(bin, "jq");
    writeFileSync(
      jq,
      '#!/bin/sh\n[ "$1" = "-r" ] || exit 1\n[ "$2" = ".[].linearIssueId" ] || exit 1\necho MAL-123\n',
    );
    chmodSync(jq, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}:${previousPath}`;
    try {
      expect(
        renderResource(
          "tasks",
          [{ linearIssueId: "MAL-123" }],
          "linearIssueId",
          ".[].linearIssueId",
        ),
      ).toBe("MAL-123");
    } finally {
      process.env.PATH = previousPath;
    }
  });
});

describe("resource commands", () => {
  test("lists fields when --json has no value", () => {
    const result = Bun.spawnSync(["bun", "src/cli.ts", "session", "list", "--json"], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("externalSessionId\n");
  });

  test("keeps plural resource commands working temporarily", () => {
    const result = Bun.spawnSync(["bun", "src/cli.ts", "sessions", "--json"], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("externalSessionId\n");
  });

  test("queries Linear issue relationships as JSON", () => {
    relatedRecords();
    const path = db!.filename;
    const task = Bun.spawnSync(
      [
        "bun",
        "src/cli.ts",
        "task",
        "list",
        "--global",
        "--task",
        "MAL-123",
        "--json",
        "linearIssueId",
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, WR_DB_PATH: path },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const session = Bun.spawnSync(
      [
        "bun",
        "src/cli.ts",
        "session",
        "list",
        "--global",
        "--session",
        "resource-session",
        "--json",
        "session",
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, WR_DB_PATH: path },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(task.exitCode).toBe(0);
    expect(JSON.parse(task.stdout.toString())).toEqual([{ linearIssueId: "MAL-123" }]);
    expect(session.exitCode).toBe(0);
    expect(JSON.parse(session.stdout.toString())).toEqual([{ session: "codex:resource-session" }]);
  });

  test("filters pull requests by GitHub state", () => {
    relatedRecords();
    const result = Bun.spawnSync(
      ["bun", "src/cli.ts", "pr", "list", "--global", "--status", "open", "--json", "state"],
      {
        cwd: process.cwd(),
        env: { ...process.env, WR_DB_PATH: db!.filename },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual([{ state: "open" }]);
  });

  test("accepts --limit and reports repository opt-in", () => {
    relatedRecords();
    const result = Bun.spawnSync(
      [
        "bun",
        "src/cli.ts",
        "repo",
        "list",
        "--global",
        "--limit",
        "1",
        "--json",
        "repoRoot,enabled",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          WR_DB_PATH: db!.filename,
          XDG_CONFIG_HOME: tempDir("wr-repos-config"),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual([
      { repoRoot: expect.any(String), enabled: false },
    ]);
  });

  test("doctor reports database, repository, commands, and hooks", () => {
    relatedRecords();
    const home = tempDir("wr-doctor-home");
    const result = Bun.spawnSync([process.execPath, "src/cli.ts", "doctor"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: home,
        CLAUDE_CONFIG_DIR: join(home, ".claude"),
        CODEX_HOME: join(home, ".codex"),
        XDG_CONFIG_HOME: join(home, ".config"),
        WR_DB_PATH: db!.filename,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    const output = result.stdout.toString();
    expect(output).toContain("quick_check=ok foreign_key_violations=0");
    expect(output).toContain("repository path=");
    expect(output).toContain("commands gh=");
    expect(output).toContain("hooks claude=missing codex=missing");
  });

  test("reports a missing jq executable", () => {
    const result = Bun.spawnSync(
      [
        process.execPath,
        "src/cli.ts",
        "task",
        "list",
        "--global",
        "--json",
        "linearIssueId",
        "--jq",
        ".",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PATH: tempDir("wr-no-jq"),
          WR_DB_PATH: join(tempDir("wr-jq-db"), "wr.db"),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("jq is required for --jq");
  });
});
