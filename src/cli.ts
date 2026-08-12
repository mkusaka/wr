#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import * as v from "valibot";
import {
  disableRepository,
  enableRepository,
  isRepositoryEnabled,
  readConfig,
  requireEnabledRepository,
} from "./config.ts";
import { defaultDbPath, openDb } from "./db.ts";
import {
  endSession,
  parseHookPayload,
  registerSessionEvent,
  resolveCurrentContext,
  type Cli,
} from "./context.ts";
import {
  addPullRequest,
  addWorkpadLink,
  doneTask,
  listSessions,
  show,
  startTask,
} from "./commands.ts";
import { CliSchema, PositiveIntegerSchema } from "./validation.ts";

const HELP = `wr - relationship ledger for tasks and CLI sessions

Usage:
  wr internal session-event --cli codex|claude
  wr internal session-end --cli codex|claude
  wr config enable [PATH]
  wr config disable [PATH]
  wr config list
  wr task start ISSUE [--title TITLE] [--worktree PATH] [--session CLI:ID]
  wr task done [ISSUE] [--session CLI:ID]
  wr pr add NUMBER [--task ISSUE] [--parent NUMBER] [--session CLI:ID]
  wr link workpad PATH [--task ISSUE] [--session CLI:ID]
  wr show [--task ISSUE | --worktree PATH] [--session CLI:ID]
  wr sessions`;

function requireCli(value: string | undefined): Cli {
  try {
    return v.parse(CliSchema, value);
  } catch {
    throw new Error("--cli must be codex or claude");
  }
}

function requireInteger(value: string | undefined, label: string): number {
  try {
    return v.parse(PositiveIntegerSchema, Number(value));
  } catch {
    throw new Error(`${label} must be a positive integer`);
  }
}

function runConfig(args: string[]): void {
  const action = args.shift();
  const { positionals } = parseArgs({
    args,
    options: {},
    allowPositionals: true,
    strict: true,
  });
  if (action === "list") {
    if (positionals.length !== 0) throw new Error("config list does not accept a path");
    const repositories = readConfig().repositories;
    console.log(repositories.length === 0 ? "No enabled repositories" : repositories.join("\n"));
    return;
  }
  if (action !== "enable" && action !== "disable") {
    throw new Error(`Unknown config command: ${action ?? ""}`);
  }
  if (positionals.length > 1) throw new Error(`config ${action} accepts at most one path`);
  const path = positionals[0] ?? ".";
  const result = action === "enable" ? enableRepository(path) : disableRepository(path);
  const state = result.changed ? `${action}d` : `already ${action}d`;
  console.log(`${state} ${result.repoRoot}`);
}

async function runInternal(args: string[]): Promise<void> {
  const action = args.shift();
  const { values } = parseArgs({
    args,
    options: { cli: { type: "string" } },
    strict: true,
  });
  const cli = requireCli(values.cli);
  const payload = parseHookPayload(await Bun.stdin.text());
  if (action !== "session-event" && action !== "session-end") {
    throw new Error(`Unknown internal command: ${action ?? ""}`);
  }
  if (action === "session-event" && !isRepositoryEnabled(payload.cwd)) return;
  const dbPath = process.env.WR_DB_PATH ?? defaultDbPath();
  if (action === "session-end" && !existsSync(dbPath)) return;
  const db = openDb(dbPath);
  try {
    if (action === "session-event") registerSessionEvent(db, cli, payload);
    else endSession(db, cli, payload);
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(HELP);
    return;
  }

  const command = args.shift();
  if (command === "internal") {
    try {
      await runInternal(args);
    } catch (error) {
      console.error(`wr hook: ${error instanceof Error ? error.message : String(error)}`);
    }
    return;
  }

  if (command === "config") {
    runConfig(args);
    return;
  }

  if (command === "sessions") {
    parseArgs({ args, options: {}, strict: true });
    const db = openDb(process.env.WR_DB_PATH);
    try {
      console.log(listSessions(db));
    } finally {
      db.close();
    }
    return;
  }

  if (command === "show") {
    const { values } = parseArgs({
      args,
      options: {
        session: { type: "string" },
        task: { type: "string" },
        worktree: { type: "string" },
      },
      strict: true,
    });
    const { session: explicitSession, task, worktree } = values;
    if (task && worktree) throw new Error("--task and --worktree cannot be used together");
    if (!task && !worktree) requireEnabledRepository(process.cwd());
    const db = openDb(process.env.WR_DB_PATH);
    try {
      const current =
        task || worktree ? null : resolveCurrentContext(db, process.cwd(), explicitSession);
      console.log(show(db, current, { task, worktree }));
    } finally {
      db.close();
    }
    return;
  }

  if (command !== "task" && command !== "pr" && command !== "link") {
    throw new Error(`Unknown command: ${command ?? ""}`);
  }
  requireEnabledRepository(process.cwd());
  const db = openDb(process.env.WR_DB_PATH);
  try {
    if (command === "task") {
      const action = args.shift();
      if (action === "start") {
        const { values, positionals } = parseArgs({
          args,
          options: {
            session: { type: "string" },
            title: { type: "string" },
            worktree: { type: "string" },
          },
          allowPositionals: true,
          strict: true,
        });
        if (positionals.length !== 1) throw new Error("A task ID is required");
        const issue = positionals[0]!;
        if (values.worktree) requireEnabledRepository(values.worktree);
        const current = resolveCurrentContext(db, process.cwd(), values.session);
        const { title, worktree } = values;
        const result = startTask(db, current, issue, { title, worktree });
        if (result.reopened) console.error(`reopened ${issue} (was done or cancelled)`);
        console.log(`started ${issue} execution=${result.executionId}`);
        return;
      }
      if (action === "done") {
        const { values, positionals } = parseArgs({
          args,
          options: { session: { type: "string" } },
          allowPositionals: true,
          strict: true,
        });
        if (positionals.length > 1) throw new Error("Only one task ID may be provided");
        const current = resolveCurrentContext(db, process.cwd(), values.session);
        const [issue] = positionals;
        const result = doneTask(db, current, issue);
        console.log(
          `done ${result.issue} finished=${result.finished} abandoned=${result.abandoned}`,
        );
        return;
      }
      throw new Error(`Unknown task command: ${action ?? ""}`);
    }

    if (command === "pr") {
      const action = args.shift();
      if (action !== "add") throw new Error(`Unknown pr command: ${action ?? ""}`);
      const { values, positionals } = parseArgs({
        args,
        options: {
          parent: { type: "string" },
          session: { type: "string" },
          task: { type: "string" },
        },
        allowPositionals: true,
        strict: true,
      });
      if (positionals.length !== 1) throw new Error("A PR number is required");
      const number = requireInteger(positionals[0], "PR number");
      const { parent: parentValue, task } = values;
      const parent =
        parentValue === undefined ? undefined : requireInteger(parentValue, "parent PR number");
      const current = resolveCurrentContext(db, process.cwd(), values.session);
      const result = addPullRequest(db, current, number, { task, parent });
      if (result.warning) console.error(`warning: ${result.warning}`);
      console.log(`added ${result.repo}#${number}`);
      return;
    }

    if (command === "link") {
      const kind = args.shift();
      if (kind !== "workpad") throw new Error(`Unknown link kind: ${kind ?? ""}`);
      const { values, positionals } = parseArgs({
        args,
        options: {
          session: { type: "string" },
          task: { type: "string" },
        },
        allowPositionals: true,
        strict: true,
      });
      if (positionals.length !== 1) throw new Error("A workpad path is required");
      const current = resolveCurrentContext(db, process.cwd(), values.session);
      const path = positionals[0]!;
      const { task } = values;
      const result = addWorkpadLink(db, current, path, task);
      console.log(`linked ${result.issue} workpad=${result.ref}`);
      return;
    }

    throw new Error(`Unknown command: ${command ?? ""}`);
  } finally {
    db.close();
  }
}

try {
  await main();
} catch (error) {
  console.error(`wr: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
