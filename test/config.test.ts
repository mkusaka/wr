import { expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  defaultConfigPath,
  disableRepository,
  enableRepository,
  isRepositoryEnabled,
  readConfig,
} from "../src/config.ts";
import { discoverCheckout } from "../src/git.ts";
import { openDb } from "../src/db.ts";
import { tempDir } from "./helpers.ts";

test("enables and disables a canonical repository root", () => {
  const env = { XDG_CONFIG_HOME: tempDir("wr-config") };
  const repoRoot = discoverCheckout(process.cwd(), true)!.repoRoot;

  expect(readConfig(env)).toEqual({ repositories: [] });
  expect(enableRepository(process.cwd(), env)).toEqual({ repoRoot, changed: true });
  expect(enableRepository(process.cwd(), env)).toEqual({ repoRoot, changed: false });
  expect(readConfig(env)).toEqual({ repositories: [repoRoot] });
  expect(isRepositoryEnabled(process.cwd(), env)).toBe(true);
  expect(disableRepository(process.cwd(), env)).toEqual({ repoRoot, changed: true });
  expect(disableRepository(process.cwd(), env)).toEqual({ repoRoot, changed: false });
  expect(isRepositoryEnabled(process.cwd(), env)).toBe(false);
});

test("rejects an invalid config file", () => {
  const env = { XDG_CONFIG_HOME: tempDir("wr-invalid-config") };
  const path = defaultConfigPath(env);
  mkdirSync(join(env.XDG_CONFIG_HOME, "wr"), { recursive: true });
  writeFileSync(path, '{"repositories":"invalid"}\n');
  expect(() => readConfig(env)).toThrow(`Invalid config: ${path}`);
});

test("config commands manage repository opt-in", async () => {
  const env = { ...process.env, XDG_CONFIG_HOME: tempDir("wr-config-cli") };
  const enable = Bun.spawn(["bun", "src/cli.ts", "config", "enable", "."], {
    cwd: process.cwd(),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await enable.exited).toBe(0);
  expect(await new Response(enable.stdout).text()).toContain("enabled ");

  const list = Bun.spawn(["bun", "src/cli.ts", "config", "list"], {
    cwd: process.cwd(),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await list.exited).toBe(0);
  expect(await new Response(list.stdout).text()).toContain(
    discoverCheckout(process.cwd(), true)!.repoRoot,
  );
});

test("session hooks skip disabled repositories and register enabled repositories", async () => {
  const dataHome = tempDir("wr-hook-data");
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: tempDir("wr-hook-config"),
    XDG_DATA_HOME: dataHome,
    TERM_SESSION_ID: "config-hook-terminal",
  };
  const payload = JSON.stringify({
    session_id: "config-hook-session",
    cwd: process.cwd(),
    source: "startup",
  });

  const runHook = async () => {
    const child = Bun.spawn(["bun", "src/cli.ts", "internal", "session-event", "--cli", "codex"], {
      cwd: process.cwd(),
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    child.stdin.write(payload);
    child.stdin.end();
    expect(await child.exited).toBe(0);
  };

  await runHook();
  const dbPath = join(dataHome, "wr", "wr.db");
  expect(existsSync(dbPath)).toBe(false);

  enableRepository(process.cwd(), env);
  await runHook();
  const db = openDb(dbPath);
  try {
    expect(
      (db.query("SELECT COUNT(*) AS count FROM cli_sessions").get() as { count: number }).count,
    ).toBe(1);
  } finally {
    db.close();
  }

  disableRepository(process.cwd(), env);
  const outside = tempDir("wr-hook-outside");
  const end = Bun.spawn(["bun", "src/cli.ts", "internal", "session-end", "--cli", "codex"], {
    cwd: process.cwd(),
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  end.stdin.write(JSON.stringify({ session_id: "config-hook-session", cwd: outside }));
  end.stdin.end();
  expect(await end.exited).toBe(0);
  const endedDb = openDb(dbPath);
  try {
    const run = endedDb.query("SELECT end_reason FROM session_runs").get() as {
      end_reason: string;
    };
    expect(run.end_reason).toBe("session_end");
  } finally {
    endedDb.close();
  }
});

test("write commands reject disabled repositories without creating a database", async () => {
  const dataHome = tempDir("wr-disabled-data");
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: tempDir("wr-disabled-config"),
    XDG_DATA_HOME: dataHome,
    CODEX_THREAD_ID: "disabled-session",
  };
  const child = Bun.spawn(["bun", "src/cli.ts", "task", "start", "TASK-DISABLED"], {
    cwd: process.cwd(),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await child.exited).toBe(1);
  expect(await new Response(child.stderr).text()).toContain("wr config enable");
  expect(existsSync(join(dataHome, "wr", "wr.db"))).toBe(false);
});
