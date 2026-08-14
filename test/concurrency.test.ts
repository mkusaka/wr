import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as v from "valibot";
import { enableRepository } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { CountRowSchema } from "../src/validation.ts";
import { tempDir } from "./helpers.ts";

const hookCommand = process.env.WR_TEST_BINARY
  ? [resolve(process.env.WR_TEST_BINARY)]
  : ["bun", "src/cli.ts"];

test("concurrent starts do not create duplicate executions", async () => {
  const dataHome = tempDir("wr-concurrent");
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: tempDir("wr-concurrent-config"),
    XDG_DATA_HOME: dataHome,
    CODEX_THREAD_ID: "concurrent-session",
    TERM_SESSION_ID: "concurrent-terminal",
  };
  enableRepository(process.cwd(), env);
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
    expect(
      v.parse(CountRowSchema, db.query("SELECT COUNT(*) AS count FROM tasks").get()).count,
    ).toBe(1);
    expect(
      v.parse(CountRowSchema, db.query("SELECT COUNT(*) AS count FROM executions").get()).count,
    ).toBe(1);
    expect(
      v.parse(
        CountRowSchema,
        db.query("SELECT COUNT(*) AS count FROM session_runs WHERE ended_at IS NULL").get(),
      ).count,
    ).toBe(1);
  } finally {
    db.close();
  }
});

test("concurrent session hooks finish and register every session", async () => {
  const dataHome = tempDir("wr-concurrent-hooks");
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: tempDir("wr-concurrent-hooks-config"),
    XDG_DATA_HOME: dataHome,
    XDG_STATE_HOME: tempDir("wr-concurrent-hooks-state"),
  };
  enableRepository(process.cwd(), env);
  const startedAt = performance.now();
  const processes = Array.from({ length: 10 }, (_, index) => {
    const child = Bun.spawn([...hookCommand, "internal", "session-event", "--cli", "codex"], {
      cwd: process.cwd(),
      env: { ...env, TERM_SESSION_ID: `concurrent-hook-terminal-${index}` },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    child.stdin.write(
      JSON.stringify({
        session_id: `concurrent-hook-session-${index}`,
        cwd: process.cwd(),
        source: "startup",
      }),
    );
    child.stdin.end();
    return child;
  });
  const results = await Promise.all(
    processes.map(async (child) => ({
      exitCode: await child.exited,
      stderr: await new Response(child.stderr).text(),
    })),
  );
  expect(performance.now() - startedAt).toBeLessThan(10_000);
  expect(results).toEqual(Array.from({ length: 10 }, () => ({ exitCode: 0, stderr: "" })));
  const phases = readFileSync(join(env.XDG_STATE_HOME, "wr", "hook.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { phase: string });
  expect(phases.filter(({ phase }) => phase === "completed")).toHaveLength(10);
  expect(phases.filter(({ phase }) => phase === "timeout")).toHaveLength(0);

  const db = openDb(join(dataHome, "wr", "wr.db"));
  try {
    expect(
      v.parse(CountRowSchema, db.query("SELECT COUNT(*) AS count FROM cli_sessions").get()).count,
    ).toBe(10);
    expect(
      v.parse(CountRowSchema, db.query("SELECT COUNT(*) AS count FROM session_runs").get()).count,
    ).toBe(10);
  } finally {
    db.close();
  }
}, 15_000);

test("session hook logs its start before stdin closes", async () => {
  const stateHome = tempDir("wr-hook-stdin-state");
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: tempDir("wr-hook-stdin-config"),
    XDG_DATA_HOME: tempDir("wr-hook-stdin-data"),
    XDG_STATE_HOME: stateHome,
    TERM_SESSION_ID: "hook-stdin-terminal",
  };
  enableRepository(process.cwd(), env);
  const child = Bun.spawn([...hookCommand, "internal", "session-event", "--cli", "codex"], {
    cwd: process.cwd(),
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const logPath = join(stateHome, "wr", "hook.jsonl");
  const deadline = Date.now() + 2_000;
  while (
    (!existsSync(logPath) || !readFileSync(logPath, "utf8").endsWith("\n")) &&
    Date.now() < deadline
  ) {
    // oxlint-disable-next-line eslint/no-await-in-loop
    await Bun.sleep(25);
  }
  try {
    expect(existsSync(logPath)).toBe(true);
    expect(
      readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => (JSON.parse(line) as { phase: string }).phase),
    ).toEqual(["spawned"]);
  } finally {
    child.stdin.write(
      JSON.stringify({ session_id: "hook-stdin-session", cwd: process.cwd(), source: "startup" }),
    );
    child.stdin.end();
    await child.exited;
  }
  expect(child.exitCode).toBe(0);
  expect(await new Response(child.stderr).text()).toBe("");
  expect(
    readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { phase: string }).phase)
      .filter((phase) => phase === "spawned"),
  ).toHaveLength(1);
}, 5_000);

test("session hook times out with its blocking phase in the diagnostic log", async () => {
  const dataHome = tempDir("wr-hook-timeout");
  const stateHome = tempDir("wr-hook-timeout-state");
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: tempDir("wr-hook-timeout-config"),
    XDG_DATA_HOME: dataHome,
    XDG_STATE_HOME: stateHome,
    TERM_SESSION_ID: "hook-timeout-terminal",
  };
  enableRepository(process.cwd(), env);
  const db = openDb(join(dataHome, "wr", "wr.db"));
  db.run("BEGIN IMMEDIATE");
  const child = Bun.spawn([...hookCommand, "internal", "session-event", "--cli", "codex"], {
    cwd: process.cwd(),
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  child.stdin.write(
    JSON.stringify({ session_id: "hook-timeout-session", cwd: process.cwd(), source: "startup" }),
  );
  child.stdin.end();
  const startedAt = performance.now();
  expect(await child.exited).toBe(0);
  expect(performance.now() - startedAt).toBeLessThan(4_000);
  expect(await new Response(child.stderr).text()).toContain("wr hook: timed out after 3s");
  db.run("ROLLBACK");
  db.close();

  const phases = readFileSync(join(stateHome, "wr", "hook.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { phase: string });
  expect(phases.at(-2)?.phase).toBe("database-write-start");
  expect(phases.at(-1)?.phase).toBe("timeout");
}, 10_000);

test("restarting a completed task reports reopen on stderr", async () => {
  const dataHome = tempDir("wr-reopen");
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: tempDir("wr-reopen-config"),
    XDG_DATA_HOME: dataHome,
    CODEX_THREAD_ID: "reopen-session",
    TERM_SESSION_ID: "reopen-terminal",
  };
  enableRepository(process.cwd(), env);
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
