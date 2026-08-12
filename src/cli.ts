#!/usr/bin/env bun
import { parseArgs } from "node:util";
import * as v from "valibot";
import { openDb } from "./db.ts";
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

async function runInternal(args: string[]): Promise<void> {
  const action = args.shift();
  const { values } = parseArgs({
    args,
    options: { cli: { type: "string" } },
    strict: true,
  });
  const cli = requireCli(values.cli);
  const payload = parseHookPayload(await Bun.stdin.text());
  const db = openDb(process.env.WR_DB_PATH);
  try {
    if (action === "session-event") registerSessionEvent(db, cli, payload);
    else if (action === "session-end") endSession(db, cli, payload);
    else throw new Error(`Unknown internal command: ${action ?? ""}`);
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

  const db = openDb(process.env.WR_DB_PATH);
  try {
    if (command === "sessions") {
      parseArgs({ args, options: {}, strict: true });
      console.log(listSessions(db));
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
      const current =
        task || worktree ? null : resolveCurrentContext(db, process.cwd(), explicitSession);
      console.log(show(db, current, { task, worktree }));
      return;
    }

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
