import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { renderToString } from "ink";
import { createElement } from "react";
import { addTask, startTask } from "../src/commands.ts";
import { filterFocusTargets, queryFocusTargets, WrUi } from "../src/ui.tsx";
import { testContext, testDb } from "./helpers.ts";

let db: Database | null = null;
afterEach(() => db?.close());

describe("ui", () => {
  test("loads active focus targets with their searchable relationships", () => {
    db = testDb();
    const current = testContext(db, "ui-session");
    addTask(db, "MAL-123", "UI task");
    startTask(db, current, "MAL-123", {});
    db.query(
      `INSERT INTO pull_requests (id, repo, number, url, head_branch, base_branch)
       VALUES ('pr-1', 'owner/repo', 42, 'https://github.com/owner/repo/pull/42', 'feature/ui', 'main')`,
    ).run();
    db.query(
      `INSERT INTO session_run_pull_requests (session_run_id, checkout_id, pull_request_id)
       VALUES ($runId, $checkoutId, 'pr-1')`,
    ).run({ runId: current.sessionRunId, checkoutId: current.checkoutId });

    const targets = queryFocusTargets(db);

    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      session: "codex:ui-session",
      taskIds: "MAL-123",
      repoRoots: [current.checkout!.repoRoot],
      branches: "feature/ui main",
      pullRequests: "owner/repo#42",
      prUrls: "https://github.com/owner/repo/pull/42",
    });
    expect(filterFocusTargets(targets, "mal-123 pull/42")).toEqual(targets);
    expect(filterFocusTargets(targets, "missing")).toEqual([]);

    const output = renderToString(createElement(WrUi, { targets }), { columns: 120 });
    expect(output).toContain("MAL-123");
    expect(output).toContain("wr");
    expect(output).toContain("#42");
    expect(output).not.toContain(current.checkout!.repoRoot);
    expect(output).not.toContain("https://github.com/owner/repo/pull/42");

    const spacedPath = renderToString(
      createElement(WrUi, {
        targets: [{ ...targets[0]!, repoRoots: ["/tmp/my repo"] }],
      }),
      { columns: 120 },
    );
    expect(spacedPath).toContain("my repo");
    expect(spacedPath).not.toContain("my, repo");
  });
});
