import { describe, expect, test } from "bun:test";
import { findCurrentSession, normalizeStoredPath, parseHookPayload } from "../src/context.ts";

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

describe("session discovery", () => {
  test.each([
    [{ DEVIN_SESSION_ID: "polite-axolotl" }, { cli: "devin", externalSessionId: "polite-axolotl" }],
    [{ WR_CLI_SESSION: "devin:calm-otter" }, { cli: "devin", externalSessionId: "calm-otter" }],
  ] as const)("detects %s", (env, expected) => {
    expect(findCurrentSession(undefined, env)).toEqual(expected);
  });

  test("fills Devin hook payload cwd from the project directory", () => {
    expect(
      parseHookPayload(
        JSON.stringify({ session_id: "polite-axolotl", source: "startup" }),
        "/Users/example/project",
      ),
    ).toEqual({
      session_id: "polite-axolotl",
      source: "startup",
      cwd: "/Users/example/project",
    });
  });

  test("rejects a hook payload without cwd when no default is provided", () => {
    expect(() => parseHookPayload(JSON.stringify({ session_id: "polite-axolotl" }))).toThrow(
      "Invalid hook payload",
    );
  });
});
