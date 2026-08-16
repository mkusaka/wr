import { describe, expect, test } from "bun:test";
import { isCurrentResource } from "../src/resources.ts";

describe("resource current scope", () => {
  test.each([
    ["tasks", { status: "open" }, true],
    ["tasks", { status: "active" }, true],
    ["tasks", { status: "done" }, false],
    ["prs", { state: "open" }, true],
    ["prs", { state: "merged" }, false],
    ["sessions", { status: "active" }, true],
    ["sessions", { status: "ended" }, false],
    ["runs", { status: "active" }, true],
    ["runs", { status: "ended" }, false],
    ["terminals", { status: "active" }, true],
    ["executions", { status: "active" }, true],
    ["executions", { status: "finished" }, false],
    ["checkouts", { branch: "main" }, true],
    ["repos", { repoRoot: "/src/example" }, true],
  ] as const)("classifies %s rows", (resource, row, expected) => {
    expect(isCurrentResource(resource, row)).toBe(expected);
  });
});
