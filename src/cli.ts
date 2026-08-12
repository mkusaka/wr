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
import { discoverCheckout } from "./git.ts";
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
  findRunTerminal,
  removePullRequest,
  show,
  startTask,
  syncPullRequests,
} from "./commands.ts";
import { renderResource } from "./output.ts";
import {
  queryResource,
  RESOURCE_FIELDS,
  type ResourceFilters,
  type ResourceName,
} from "./resources.ts";
import {
  CliSchema,
  ExecutionStatusSchema,
  ITermSessionListSchema,
  NonEmptyStringSchema,
  PositiveIntegerSchema,
  ResourceNameSchema,
  RunStatusSchema,
  TaskStatusSchema,
} from "./validation.ts";

const HELP = `wr - relationship ledger for tasks and CLI sessions

Usage:
  wr internal session-event --cli codex|claude
  wr internal session-end --cli codex|claude
  wr config enable [PATH]
  wr config disable [PATH]
  wr config list
  wr task start ISSUE [--title TITLE] [--worktree PATH] [--session ID]
  wr task done [ISSUE] [--session ID]
  wr pr add NUMBER [--task ISSUE] [--parent NUMBER] [--session ID]
  wr pr remove NUMBER [--task ISSUE] [--session ID]
  wr link workpad PATH [--task ISSUE] [--session ID]
  wr show [--task ISSUE | --worktree PATH] [--session ID]
  wr sync [--session ID]
  wr tasks|sessions|runs|checkouts|executions|links|prs|branches|terminals [FILTERS]
  wr runs focus SESSION_ID|RUN_ID
  wr terminals focus TERMINAL_ID

Resource filters:
  --task ISSUE          Linear issue identifier
  --session ID          Codex thread ID or Claude session ID
  --run ID              Session run ID
  --checkout ID         Git checkout ID
  --execution ID        Execution ID
  --link ID             Task link ID
  --terminal ID         iTerm2 session ID
  --repo PATH           Repository containing related records
  --worktree PATH       Worktree containing related records
  --branch BRANCH       Branch containing related records
  --pr NUMBER           Pull request containing related records
  --status STATUS       Status supported by the selected resource
  --kind KIND           Link kind (links only)
  --global              Do not infer repository scope from cwd
  --json FIELDS         Output selected comma-separated fields; omit value to list fields
  --jq, -q EXPR         Filter JSON output with jq`;

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

function optionalString(value: string | undefined, option: string): string | undefined {
  if (value === undefined) return undefined;
  try {
    return v.parse(NonEmptyStringSchema, value);
  } catch {
    throw new Error(`${option} must not be empty`);
  }
}

function getLiveTerminalIds(): Set<string> | undefined {
  const result = (() => {
    try {
      return Bun.spawnSync(["it2", "session", "list", "--json"], {
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch {
      return null;
    }
  })();
  if (!result) return undefined;
  if (result.exitCode !== 0) return undefined;
  try {
    const sessions = v.parse(ITermSessionListSchema, JSON.parse(result.stdout.toString()));
    return new Set(sessions.map((session) => session.id));
  } catch {
    return undefined;
  }
}

function requireResource(value: string | undefined): ResourceName | null {
  const result = v.safeParse(ResourceNameSchema, value);
  return result.success ? result.output : null;
}

function resourceStatus(resource: ResourceName, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    if (resource === "tasks") return v.parse(TaskStatusSchema, value);
    if (resource === "executions") return v.parse(ExecutionStatusSchema, value);
    if (resource === "runs" || resource === "terminals") return v.parse(RunStatusSchema, value);
  } catch {
    if (resource === "tasks") throw new Error("--status must be open, active, done, or cancelled");
    if (resource === "executions")
      throw new Error("--status must be active, finished, or abandoned");
    throw new Error("--status must be active or ended");
  }
  throw new Error(`--status is not supported by ${resource}`);
}

function hasBareJson(args: string[]): boolean {
  const index = args.indexOf("--json");
  return index >= 0 && (args[index + 1] === undefined || args[index + 1]!.startsWith("-"));
}

function paneStatus(itermSessionId: unknown, live: Set<string> | undefined): string {
  if (live === undefined) return "unknown";
  if (typeof itermSessionId !== "string") return "closed";
  return live.has(itermSessionId.split(":").at(-1)!) ? "live" : "closed";
}

function runResource(resource: ResourceName, args: string[]): void {
  if (hasBareJson(args)) {
    if (args.some((arg) => arg === "--jq" || arg === "-q" || arg.startsWith("--jq=")))
      throw new Error("--jq requires --json FIELDS");
    console.log(RESOURCE_FIELDS[resource].join("\n"));
    return;
  }
  const { values } = parseArgs({
    args,
    options: {
      task: { type: "string" },
      session: { type: "string" },
      run: { type: "string" },
      checkout: { type: "string" },
      execution: { type: "string" },
      link: { type: "string" },
      terminal: { type: "string" },
      repo: { type: "string" },
      worktree: { type: "string" },
      branch: { type: "string" },
      pr: { type: "string" },
      status: { type: "string" },
      kind: { type: "string" },
      global: { type: "boolean" },
      json: { type: "string" },
      jq: { type: "string", short: "q" },
    },
    strict: true,
  });
  if (values.global && values.repo) throw new Error("--global and --repo cannot be used together");
  if (values.kind !== undefined && resource !== "links")
    throw new Error(`--kind is not supported by ${resource}`);

  const worktree = values.worktree ? discoverCheckout(values.worktree, true)! : undefined;
  const repo = values.repo ? discoverCheckout(values.repo, true)! : undefined;
  const filters: ResourceFilters = {
    task: optionalString(values.task, "--task"),
    session: optionalString(values.session, "--session"),
    run: optionalString(values.run, "--run"),
    checkout: optionalString(values.checkout, "--checkout"),
    execution: optionalString(values.execution, "--execution"),
    link: optionalString(values.link, "--link"),
    terminal: optionalString(values.terminal, "--terminal"),
    repoRoot: values.global
      ? undefined
      : (repo?.repoRoot ?? worktree?.repoRoot ?? discoverCheckout(process.cwd())?.repoRoot),
    worktreePath: worktree?.worktreePath,
    branch: optionalString(values.branch, "--branch"),
    pullRequest: values.pr === undefined ? undefined : requireInteger(values.pr, "PR number"),
    status: resourceStatus(resource, values.status),
    kind: optionalString(values.kind, "--kind"),
  };
  const db = openDb(process.env.WR_DB_PATH);
  try {
    let rows = queryResource(db, resource, filters);
    if (resource === "runs" || resource === "terminals") {
      const live = getLiveTerminalIds();
      rows = rows.map((row) => ({ ...row, pane: paneStatus(row.itermSessionId, live) }));
    }
    console.log(renderResource(resource, rows, values.json, values.jq));
  } finally {
    db.close();
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

  const resource = requireResource(command);
  if (resource && (resource === "runs" || resource === "terminals") && args[0] === "focus") {
    args.shift();
    const db = openDb(process.env.WR_DB_PATH);
    try {
      const { positionals } = parseArgs({
        args,
        options: {},
        allowPositionals: true,
        strict: true,
      });
      if (positionals.length !== 1)
        throw new Error(
          resource === "runs" ? "A CLI session or run ID is required" : "A terminal ID is required",
        );
      const terminalId =
        resource === "runs"
          ? findRunTerminal(db, positionals[0]!)
          : positionals[0]!.split(":").at(-1)!;
      const result = Bun.spawnSync(["it2", "session", "focus", terminalId], {
        stdout: "pipe",
        stderr: "pipe",
      });
      if (result.exitCode !== 0)
        throw new Error(result.stderr.toString().trim() || "Could not focus the iTerm2 pane");
      console.log(`focused terminal=${terminalId}`);
    } finally {
      db.close();
    }
    return;
  }

  if (resource) {
    runResource(resource, args);
    return;
  }

  if (command === "sync") {
    requireEnabledRepository(process.cwd());
    const { values } = parseArgs({
      args,
      options: { session: { type: "string" } },
      strict: true,
    });
    const db = openDb(process.env.WR_DB_PATH);
    try {
      const current = resolveCurrentContext(db, process.cwd(), values.session);
      const result = syncPullRequests(db, current);
      console.log(
        `synced checkouts=${result.checkouts} prs=${result.pullRequests} linked=${result.linked} skipped=${result.skipped}`,
      );
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
      if (action !== "add" && action !== "remove")
        throw new Error(`Unknown pr command: ${action ?? ""}`);
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
      if (action === "remove") {
        if (values.parent !== undefined) throw new Error("pr remove does not accept --parent");
        const current = values.task
          ? null
          : resolveCurrentContext(db, process.cwd(), values.session);
        const result = removePullRequest(db, current, number, values.task);
        console.log(`removed ${result.repo}#${number} task=${result.issue}`);
        return;
      }
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
