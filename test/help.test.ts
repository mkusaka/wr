import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers.ts";

const cases = [
  { name: "no arguments", args: [], expected: "Relationship ledger" },
  { name: "top level", args: ["--help"], expected: "Relationship ledger" },
  { name: "config", args: ["config", "--help"], expected: "Usage: wr config list" },
  {
    name: "config action",
    args: ["config", "enable", "-h"],
    expected: "Usage: wr config enable [STRING]",
  },
  { name: "task", args: ["task", "--help"], expected: "Usage: wr task list" },
  {
    name: "task help command",
    args: ["help", "task"],
    expected: "Usage: wr task list",
  },
  {
    name: "task action",
    args: ["task", "start", "--help"],
    expected: "Usage: wr task start",
  },
  { name: "pr", args: ["pr", "--help"], expected: "Usage: wr pr list" },
  {
    name: "pr action",
    args: ["pr", "remove", "-h"],
    expected: "Usage: wr pr remove --task STRING VALUE",
  },
  { name: "link", args: ["link", "--help"], expected: "Usage: wr link list" },
  {
    name: "link action",
    args: ["link", "workpad", "remove", "--help"],
    expected: "Usage: wr link workpad remove",
  },
  { name: "show", args: ["show", "--help"], expected: "Usage: wr show" },
  { name: "sync", args: ["sync", "-h"], expected: "Usage: wr sync" },
  { name: "doctor", args: ["doctor", "--help"], expected: "Usage: wr doctor" },
  { name: "ui", args: ["ui", "--help"], expected: "Usage: wr ui" },
  { name: "task list", args: ["task", "list", "--help"], expected: "Usage: wr task list" },
  {
    name: "session list",
    args: ["session", "list", "--help"],
    expected: "Usage: wr session list",
  },
  { name: "run list", args: ["run", "list", "--help"], expected: "Usage: wr run list" },
  {
    name: "checkout list",
    args: ["checkout", "list", "--help"],
    expected: "Usage: wr checkout list",
  },
  {
    name: "execution list",
    args: ["execution", "list", "--help"],
    expected: "Usage: wr execution list",
  },
  { name: "link list", args: ["link", "list", "--help"], expected: "Usage: wr link list" },
  { name: "pr list", args: ["pr", "list", "--help"], expected: "Usage: wr pr list" },
  {
    name: "branch list",
    args: ["branch", "list", "--help"],
    expected: "Usage: wr branch list",
  },
  {
    name: "terminal list",
    args: ["terminal", "list", "--help"],
    expected: "Usage: wr terminal list",
  },
  { name: "repo list", args: ["repo", "list", "--help"], expected: "Usage: wr repo list" },
  {
    name: "run focus",
    args: ["run", "focus", "--help"],
    expected: "Usage: wr run focus STRING",
  },
  {
    name: "terminal focus",
    args: ["terminal", "focus", "-h"],
    expected: "Usage: wr terminal focus STRING",
  },
];

test.each(cases)("prints $name help without repository opt-in", (item) => {
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

test("keeps legacy command help available but hidden from top-level help", () => {
  const top = Bun.spawnSync([process.execPath, "src/cli.ts", "--help"], { stdout: "pipe" });
  expect(top.stdout.toString()).not.toContain("\n  tasks");

  const legacy = Bun.spawnSync([process.execPath, "src/cli.ts", "tasks", "--help"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(legacy.exitCode).toBe(0);
  expect(legacy.stdout.toString()).toContain("Usage: wr tasks");
});
