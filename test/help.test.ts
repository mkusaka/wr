import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers.ts";

const cases = [
  { name: "top level", args: ["--help"], expected: "wr - relationship ledger" },
  { name: "config", args: ["config", "--help"], expected: "wr config enable [PATH]" },
  { name: "config action", args: ["config", "enable", "-h"], expected: "wr config list" },
  { name: "task", args: ["task", "--help"], expected: "wr task add ISSUE" },
  { name: "task action", args: ["task", "start", "--help"], expected: "wr task done [ISSUE]" },
  { name: "pull request", args: ["pr", "--help"], expected: "wr pr add NUMBER" },
  { name: "pull request action", args: ["pr", "remove", "-h"], expected: "wr pr remove NUMBER" },
  { name: "link", args: ["link", "--help"], expected: "wr link workpad REF" },
  {
    name: "link action",
    args: ["link", "remove", "workpad", "--help"],
    expected: "wr link remove workpad REF",
  },
  { name: "show", args: ["show", "--help"], expected: "wr show [--task ISSUE" },
  { name: "sync", args: ["sync", "-h"], expected: "wr sync [--session ID]" },
  { name: "doctor", args: ["doctor", "--help"], expected: "wr doctor" },
  ...[
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
  ].map((resource) => ({
    name: resource,
    args: [resource, "--help"],
    expected: `wr ${resource} [FILTERS]`,
  })),
  { name: "run focus", args: ["runs", "focus", "--help"], expected: "wr runs focus" },
  {
    name: "terminal focus",
    args: ["terminals", "focus", "-h"],
    expected: "wr terminals focus",
  },
];

for (const item of cases) {
  test(`prints ${item.name} help without repository opt-in`, () => {
    const home = tempDir("wr-help");
    const result = Bun.spawnSync([process.execPath, "src/cli.ts", ...item.args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        XDG_CONFIG_HOME: join(home, "config"),
        XDG_DATA_HOME: join(home, "data"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    expect(result.stdout.toString()).toContain(item.expected);
    expect(existsSync(join(home, "data", "wr", "wr.db"))).toBe(false);
  });
}
