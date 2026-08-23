import { describe, expect, test } from "bun:test";
import { renderResource, renderShow } from "../src/output.ts";

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
        executions: [
          {
            status: "active",
            cli: "codex",
            externalSessionId: "thread",
            worktreePath: "/src/repo",
            branch: "main",
          },
        ],
        pullRequests: [{ repo: "example/repo", number: 1, url: "https://example.test/1" }],
        links: [{ kind: "workpad", ref: "/tmp/workpad.md" }],
      },
    ]);
    expect(output).toContain("Task MOQ-1 [active] Task");
    expect(output).toContain("Execution active: codex:thread");
    expect(output).toContain("PR example/repo#1");
    expect(output).toContain("workpad: /tmp/workpad.md");
  });
});
