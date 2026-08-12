import { expect, test } from "bun:test";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { tempDir } from "./helpers.ts";

test("concurrent starts do not create duplicate executions", async () => {
  const dataHome = tempDir("wr-concurrent");
  const env = {
    ...process.env,
    XDG_DATA_HOME: dataHome,
    CODEX_THREAD_ID: "concurrent-session",
    TERM_SESSION_ID: "concurrent-terminal",
  };
  const processes = Array.from({ length: 6 }, () =>
    Bun.spawn(["bun", "src/cli.ts", "task", "start", "TASK-CONCURRENT"], {
      cwd: process.cwd(),
      env,
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
  const results = await Promise.all(
    processes.map(async (child) => ({
      exitCode: await child.exited,
      stderr: await new Response(child.stderr).text(),
    })),
  );
  const failures = results.filter((result) => result.exitCode !== 0);
  if (failures.length) throw new Error(failures.map((result) => result.stderr).join("\n"));

  const db = openDb(join(dataHome, "wr", "wr.db"));
  try {
    expect((db.query("SELECT COUNT(*) AS count FROM tasks").get() as { count: number }).count).toBe(
      1,
    );
    expect(
      (db.query("SELECT COUNT(*) AS count FROM executions").get() as { count: number }).count,
    ).toBe(1);
    expect(
      (
        db.query("SELECT COUNT(*) AS count FROM session_runs WHERE ended_at IS NULL").get() as {
          count: number;
        }
      ).count,
    ).toBe(1);
  } finally {
    db.close();
  }
});

test("restarting a completed task reports reopen on stderr", async () => {
  const dataHome = tempDir("wr-reopen");
  const env = {
    ...process.env,
    XDG_DATA_HOME: dataHome,
    CODEX_THREAD_ID: "reopen-session",
    TERM_SESSION_ID: "reopen-terminal",
  };
  for (const args of [
    ["task", "start", "TASK-REOPEN"],
    ["task", "done", "TASK-REOPEN"],
  ]) {
    const child = Bun.spawn(["bun", "src/cli.ts", ...args], {
      cwd: process.cwd(),
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    // The second command depends on the first command completing.
    // oxlint-disable-next-line eslint/no-await-in-loop
    expect(await child.exited).toBe(0);
  }
  const reopened = Bun.spawn(["bun", "src/cli.ts", "task", "start", "TASK-REOPEN"], {
    cwd: process.cwd(),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await reopened.exited).toBe(0);
  expect(await new Response(reopened.stderr).text()).toContain("reopened TASK-REOPEN");
});
