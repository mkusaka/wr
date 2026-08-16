import { describe, expect, test } from "bun:test";
import { normalizeStoredPath } from "../src/context.ts";

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
