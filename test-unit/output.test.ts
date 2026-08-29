import { describe, expect, test } from "bun:test";
import { renderResource, renderSessionLineage, renderShow } from "../src/output.ts";

describe("resource output", () => {
  test("removes control characters from human-readable output", () => {
    const output = renderResource("tasks", [
      {
        linearIssueId: "MOQ-1\u001b[31m",
        title: "line\nbreak",
        status: "open",
        updatedAt: "now",
      },
    ]);
    expect(output).not.toContain("\u001b");
    expect(output).not.toContain("line\nbreak");
  });

  test("preserves values in JSON output", () => {
    const output = renderResource(
      "tasks",
      [{ linearIssueId: "MOQ-1", title: "line\nbreak", status: "open", updatedAt: "now" }],
      "title",
    );
    expect(JSON.parse(output)).toEqual([{ title: "line\nbreak" }]);
  });

  test("shows non-current count at the bottom of human output", () => {
    const output = renderResource("tasks", [], undefined, undefined, 2);
    expect(output).toBe("No current tasks\n+ 2 non-current");
  });

  test("appends non-current count to existing human output", () => {
    const output = renderResource(
      "prs",
      [{ repo: "example/repo", number: 1, state: "open", url: "https://example.test/1" }],
      undefined,
      undefined,
      3,
    );
    expect(output).toContain("repo=example/repo");
    expect(output).toContain("+ 3 non-current");
  });

  test("renders run list as a parent-child tree", () => {
    const output = renderResource("runs", [
      {
        id: "run-1",
        sessionId: "session-a",
        parentCliSessionId: null,
        session: "codex:parent",
        status: "active",
        deviceName: "Work laptop",
        itermSessionId: "term-1",
        lastSeenAt: "2026-08-15 12:00:00",
        startedAt: "2026-08-15 11:00:00",
      },
      {
        id: "run-2",
        sessionId: "session-b",
        parentCliSessionId: "session-a",
        session: "claude:child",
        status: "active",
        deviceName: "Work laptop",
        itermSessionId: "term-2",
        lastSeenAt: "2026-08-15 12:01:00",
        startedAt: "2026-08-15 11:30:00",
      },
    ]);
    expect(output).toContain("id=run-1");
    expect(output).toContain("└─");
    expect(output).toContain("id=run-2");
  });

  test("links a child run to the latest parent run by session and startedAt", () => {
    const output = renderResource("runs", [
      {
        id: "run-1",
        sessionId: "session-a",
        parentCliSessionId: null,
        session: "codex:parent-1",
        status: "active",
        deviceName: "Work laptop",
        itermSessionId: "term-1",
        lastSeenAt: "2026-08-15 12:00:00",
        startedAt: "2026-08-15 10:00:00",
      },
      {
        id: "run-2",
        sessionId: "session-a",
        parentCliSessionId: null,
        session: "codex:parent-2",
        status: "active",
        deviceName: "Work laptop",
        itermSessionId: "term-2",
        lastSeenAt: "2026-08-15 12:01:00",
        startedAt: "2026-08-15 11:00:00",
      },
      {
        id: "run-3",
        sessionId: "session-b",
        parentCliSessionId: "session-a",
        session: "claude:child",
        status: "active",
        deviceName: "Work laptop",
        itermSessionId: "term-3",
        lastSeenAt: "2026-08-15 12:02:00",
        startedAt: "2026-08-15 11:30:00",
      },
    ]);
    expect(output).toContain("id=run-2");
    expect(output).toContain("└─");
    expect(output).toContain("id=run-3");
    expect(output.indexOf("id=run-2")).toBeLessThan(output.indexOf("id=run-3"));
  });

  test("ignores non-current count in JSON output", () => {
    const output = renderResource(
      "tasks",
      [{ linearIssueId: "MOQ-1", status: "open", updatedAt: "now" }],
      "linearIssueId",
      undefined,
      5,
    );
    expect(JSON.parse(output)).toEqual([{ linearIssueId: "MOQ-1" }]);
  });

  test("renders show relationships for humans", () => {
    const output = renderShow([
      {
        linearIssueId: "MOQ-1",
        title: "Task",
        status: "active",
        deviceNames: ["Work laptop"],
        executions: [
          {
            status: "active",
            cli: "codex",
            externalSessionId: "thread",
            deviceName: "Work laptop",
            worktreePath: "/src/repo",
            branch: "main",
          },
        ],
        pullRequests: [
          {
            repo: "example/repo",
            number: 1,
            url: "https://example.test/1",
            deviceNames: ["Work laptop"],
          },
        ],
        links: [{ kind: "workpad", ref: "/tmp/workpad.md", deviceName: "Work laptop" }],
      },
    ]);
    expect(output).toContain("Task MOQ-1 [active] Task");
    expect(output).toContain("Execution active: codex:thread");
    expect(output).toContain("PR example/repo#1");
    expect(output).toContain("workpad: /tmp/workpad.md");
    expect(output).toContain("devices=Work laptop");
    expect(output).toContain("device=Work laptop");
  });

  test("renders ancestor path and descendant tree", () => {
    expect(
      renderSessionLineage({
        ancestors: [
          {
            id: "codex",
            cli: "codex",
            externalSessionId: "parent",
            status: "ended",
          },
        ],
        session: {
          id: "claude",
          cli: "claude",
          externalSessionId: "child",
          status: "active",
          children: [
            {
              id: "devin",
              cli: "devin",
              externalSessionId: "grandchild",
              status: "active",
              children: [],
            },
          ],
        },
      }),
    ).toBe("codex:parent [ended]\n└─ claude:child [active]\n   └─ devin:grandchild [active]");
  });
});
