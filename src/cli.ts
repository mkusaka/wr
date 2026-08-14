#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { object, or } from "@optique/core/constructs";
import { message } from "@optique/core/message";
import { optional, withDefault } from "@optique/core/modifiers";
import { argument, command, constant, option } from "@optique/core/primitives";
import { string as optiqueString } from "@optique/core/valueparser";
import { run } from "@optique/run";
import { valibot } from "@optique/valibot";
import { render } from "ink";
import { createElement } from "react";
import * as v from "valibot";
import {
  addPullRequest,
  addTask,
  addWorkpadLink,
  cancelTask,
  doneTask,
  findRunTerminal,
  removePullRequest,
  removeWorkpadLink,
  show,
  startTask,
  syncPullRequests,
} from "./commands.ts";
import {
  disableRepository,
  enableRepository,
  isRepositoryEnabled,
  readConfig,
  requireEnabledRepository,
} from "./config.ts";
import {
  endSession,
  findCurrentSession,
  parseHookPayload,
  registerSessionEvent,
  resolveCurrentContext,
  type Cli,
} from "./context.ts";
import { defaultDbPath, openDb } from "./db.ts";
import { discoverCheckout } from "./git.ts";
import { renderResource } from "./output.ts";
import {
  queryResource,
  RESOURCE_FIELDS,
  type ResourceFilters,
  type ResourceName,
} from "./resources.ts";
import { queryFocusTargets, WrUi } from "./ui.tsx";
import {
  CliSchema,
  DbIntegerSchema,
  ExecutionStatusSchema,
  ITermSessionListSchema,
  NonEmptyStringSchema,
  PositiveIntegerSchema,
  RecordListSchema,
  RepositoryStatusSchema,
  RunStatusSchema,
  TaskStatusSchema,
} from "./validation.ts";

type ResourceOptions = {
  task?: string;
  session?: string;
  run?: string;
  checkout?: string;
  execution?: string;
  link?: string;
  terminal?: string;
  repo?: string;
  worktree?: string;
  branch?: string;
  pr?: number;
  status?: string;
  kind?: string;
  global?: boolean;
  json?: string | boolean;
  jq?: string;
  limit?: number;
};

const PositiveIntegerArgumentSchema = v.pipe(
  v.string(),
  v.transform((value) => Number(value)),
  PositiveIntegerSchema,
);

const textValue = valibot(NonEmptyStringSchema, { placeholder: "VALUE" });
const positiveIntegerValue = valibot(PositiveIntegerArgumentSchema, { placeholder: 1 });

function withDb<T>(callback: (db: Database) => T): T {
  const db = openDb(process.env.WR_DB_PATH);
  try {
    return callback(db);
  } finally {
    db.close();
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
  if (!result || result.exitCode !== 0) return undefined;
  try {
    const sessions = v.parse(ITermSessionListSchema, JSON.parse(result.stdout.toString()));
    return new Set(sessions.map((session) => session.id));
  } catch {
    return undefined;
  }
}

function resourceStatus(resource: ResourceName, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    if (resource === "tasks") return v.parse(TaskStatusSchema, value);
    if (resource === "executions") return v.parse(ExecutionStatusSchema, value);
    if (resource === "runs" || resource === "terminals") return v.parse(RunStatusSchema, value);
    if (resource === "repos") return v.parse(RepositoryStatusSchema, value);
  } catch {
    if (resource === "tasks") throw new Error("--status must be open, active, done, or cancelled");
    if (resource === "executions")
      throw new Error("--status must be active, finished, or abandoned");
    if (resource === "repos") throw new Error("--status must be active or inactive");
    throw new Error("--status must be active or ended");
  }
  throw new Error(`--status is not supported by ${resource}`);
}

function paneStatus(itermSessionId: unknown, live: Set<string> | undefined): string {
  if (live === undefined) return "unknown";
  if (typeof itermSessionId !== "string") return "closed";
  return live.has(itermSessionId.split(":").at(-1)!) ? "live" : "closed";
}

function resourceOptions() {
  return {
    task: optional(option("--task", textValue, { description: message`Filter by task.` })),
    session: optional(
      option("--session", textValue, { description: message`Filter by CLI session.` }),
    ),
    run: optional(option("--run", textValue, { description: message`Filter by session run.` })),
    checkout: optional(
      option("--checkout", textValue, { description: message`Filter by checkout.` }),
    ),
    execution: optional(
      option("--execution", textValue, { description: message`Filter by execution.` }),
    ),
    link: optional(option("--link", textValue, { description: message`Filter by link.` })),
    terminal: optional(
      option("--terminal", textValue, { description: message`Filter by terminal.` }),
    ),
    repo: optional(option("--repo", textValue, { description: message`Select a repository.` })),
    worktree: optional(
      option("--worktree", textValue, { description: message`Filter by worktree.` }),
    ),
    branch: optional(option("--branch", textValue, { description: message`Filter by branch.` })),
    pr: optional(
      option("--pr", positiveIntegerValue, { description: message`Filter by pull request.` }),
    ),
    status: optional(option("--status", textValue, { description: message`Filter by status.` })),
    kind: optional(option("--kind", textValue, { description: message`Filter links by kind.` })),
    limit: optional(
      option("--limit", positiveIntegerValue, {
        description: message`Limit the number of records.`,
      }),
    ),
    global: option("--global", { description: message`Do not infer repository scope from cwd.` }),
    json: optional(
      or(
        option("--json", optiqueString({ metavar: "FIELDS" }), {
          description: message`Output selected fields as JSON.`,
        }),
        option("--json", { description: message`List available JSON fields.` }),
      ),
    ),
    jq: optional(
      option("-q", "--jq", textValue, { description: message`Filter JSON output with jq.` }),
    ),
  };
}

function runResource(resource: ResourceName, values: ResourceOptions): void {
  if (values.json === true) {
    if (values.jq) throw new Error("--jq requires --json FIELDS");
    console.log(RESOURCE_FIELDS[resource].join("\n"));
    return;
  }
  if (values.global && values.repo) throw new Error("--global and --repo cannot be used together");
  if (values.kind !== undefined && resource !== "links")
    throw new Error(`--kind is not supported by ${resource}`);

  const worktree = values.worktree ? discoverCheckout(values.worktree, true)! : undefined;
  const repo = values.repo ? discoverCheckout(values.repo, true)! : undefined;
  const filters: ResourceFilters = {
    task: values.task,
    session: values.session,
    run: values.run,
    checkout: values.checkout,
    execution: values.execution,
    link: values.link,
    terminal: values.terminal,
    repoRoot: values.global
      ? undefined
      : (repo?.repoRoot ?? worktree?.repoRoot ?? discoverCheckout(process.cwd())?.repoRoot),
    worktreePath: worktree?.worktreePath,
    branch: values.branch,
    pullRequest: values.pr,
    status: resourceStatus(resource, values.status),
    kind: values.kind,
    limit: values.limit,
  };
  withDb((db) => {
    if (isRepositoryEnabled(process.cwd()) && findCurrentSession(db)) {
      resolveCurrentContext(db, process.cwd());
    }
    let rows = queryResource(db, resource, filters);
    if (resource === "runs" || resource === "terminals") {
      const live = getLiveTerminalIds();
      rows = rows.map((row) => ({ ...row, pane: paneStatus(row.itermSessionId, live) }));
    }
    if (resource === "repos") {
      const enabled = new Set(readConfig().repositories);
      rows = rows.map((row) => ({ ...row, enabled: enabled.has(String(row.repoRoot)) }));
    }
    console.log(
      renderResource(
        resource,
        rows,
        typeof values.json === "string" ? values.json : undefined,
        values.jq,
      ),
    );
  });
}

function runDoctor(): void {
  const dbPath = process.env.WR_DB_PATH ?? defaultDbPath();
  const checkout = discoverCheckout(process.cwd());
  const lines: string[] = [];
  if (!existsSync(dbPath)) {
    lines.push(`database path=${dbPath} status=missing`);
    lines.push("session status=not-checked");
  } else {
    const db = new Database(dbPath, { readonly: true, strict: true });
    try {
      const version = v.parse(
        v.object({ user_version: DbIntegerSchema }),
        db.query("PRAGMA user_version").get(),
      );
      const quickRows = v.parse(RecordListSchema, db.query("PRAGMA quick_check").all());
      const quick = quickRows.every((row) => Object.values(row)[0] === "ok") ? "ok" : "failed";
      const foreignKeyViolations = db.query("PRAGMA foreign_key_check").all().length;
      lines.push(
        `database path=${dbPath} status=ok schema=${version.user_version} quick_check=${quick} foreign_key_violations=${foreignKeyViolations}`,
      );
      const identity = findCurrentSession(db);
      if (!identity) {
        lines.push("session status=not-detected");
      } else {
        const row = v.parse(
          v.nullable(v.object({ id: NonEmptyStringSchema, activeRuns: DbIntegerSchema })),
          db
            .query(
              `SELECT cs.id, COUNT(sr.id) AS activeRuns
                 FROM cli_sessions cs
                 LEFT JOIN session_runs sr ON sr.cli_session_id = cs.id AND sr.ended_at IS NULL
                WHERE cs.cli = $cli AND cs.external_session_id = $externalSessionId
                GROUP BY cs.id`,
            )
            .get(identity),
        );
        lines.push(
          `session identity=${identity.cli}:${identity.externalSessionId} registered=${row ? "yes" : "no"} active_runs=${row?.activeRuns ?? 0}`,
        );
      }
    } finally {
      db.close();
    }
  }
  lines.push(
    checkout
      ? `repository path=${checkout.repoRoot} enabled=${isRepositoryEnabled(process.cwd()) ? "yes" : "no"}`
      : "repository status=not-detected",
  );
  lines.push(
    `commands gh=${Bun.which("gh") ? "available" : "missing"} jq=${Bun.which("jq") ? "available" : "missing"} it2=${Bun.which("it2") ? "available" : "missing"}`,
  );
  const home = process.env.HOME;
  if (home) {
    const claudePath = join(
      process.env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"),
      "settings.json",
    );
    const codexPath = join(process.env.CODEX_HOME ?? join(home, ".codex"), "hooks.json");
    const claude = existsSync(claudePath) ? readFileSync(claudePath, "utf8") : "";
    const codex = existsSync(codexPath) ? readFileSync(codexPath, "utf8") : "";
    lines.push(
      `hooks claude=${claude.includes("wr internal session-event --cli claude") && claude.includes("wr internal session-end --cli claude") ? "configured" : "missing"} codex=${codex.includes("wr internal session-event --cli codex") && codex.includes("wr internal session-end --cli codex") ? "configured" : "missing"}`,
    );
  } else {
    lines.push("hooks claude=unknown codex=unknown");
  }
  console.log(lines.join("\n"));
}

function focusTerminal(target: string, resolveRun: boolean): void {
  withDb((db) => {
    const terminalId = resolveRun ? findRunTerminal(db, target) : target.split(":").at(-1)!;
    const result = Bun.spawnSync(["it2", "session", "focus", terminalId], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0)
      throw new Error(result.stderr.toString().trim() || "Could not focus the iTerm2 pane");
    console.log(`focused terminal=${terminalId}`);
  });
}

async function runInternal(
  action: "session-event" | "session-end",
  cliValue: string,
): Promise<void> {
  const startedAt = performance.now();
  const operationId = process.env.WR_HOOK_OPERATION_ID ?? crypto.randomUUID();
  const logPath =
    process.env.WR_HOOK_LOG_PATH ??
    join(
      process.env.XDG_STATE_HOME ?? join(process.env.HOME ?? process.cwd(), ".local", "state"),
      "wr",
      "hook.jsonl",
    );
  const log = (phase: string, details: Record<string, unknown> = {}) => {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(
      logPath,
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        operationId,
        pid: process.pid,
        action,
        cli: cliValue,
        phase,
        elapsedMs: Math.round(performance.now() - startedAt),
        ...details,
      })}\n`,
    );
  };

  const isWorker = process.env.WR_HOOK_WORKER === "1";
  if (!isWorker) log("spawned");
  const payloadText = await Bun.stdin.text();
  if (!isWorker) {
    log("received");
    const sourceEntrypoint = !Bun.main.startsWith("/$bunfs/");
    const child = Bun.spawn(
      [
        process.execPath,
        ...(sourceEntrypoint ? [Bun.main] : []),
        "internal",
        action,
        "--cli",
        cliValue,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, WR_HOOK_OPERATION_ID: operationId, WR_HOOK_WORKER: "1" },
        stdin: new TextEncoder().encode(payloadText),
        stdout: "ignore",
        stderr: "pipe",
        timeout: 3_000,
        killSignal: "SIGKILL",
      },
    );
    log("worker-started", { workerPid: child.pid });
    const stderrPromise = new Response(child.stderr).text();
    const exitCode = await child.exited;
    const stderr = (await stderrPromise).trim();
    if (child.signalCode === "SIGKILL") {
      log("timeout", { workerPid: child.pid });
      console.error(`wr hook: timed out after 3s; see ${logPath}`);
    } else {
      log("worker-exited", { workerPid: child.pid, exitCode, stderr: stderr || undefined });
      if (stderr) console.error(stderr);
    }
    return;
  }

  try {
    log("parse-start");
    const result = v.safeParse(CliSchema, cliValue);
    if (!result.success) throw new Error("--cli must be codex or claude");
    const cli: Cli = result.output;
    const payload = parseHookPayload(payloadText);
    log("parse-completed", { source: payload.source });
    if (action === "session-event") {
      log("repository-check-start");
      if (!isRepositoryEnabled(payload.cwd)) {
        log("repository-disabled");
        return;
      }
      log("repository-check-completed");
    }
    const dbPath = process.env.WR_DB_PATH ?? defaultDbPath();
    if (action === "session-end" && !existsSync(dbPath)) {
      log("database-missing");
      return;
    }
    log("database-open-start");
    const db = openDb(dbPath);
    log("database-open-completed");
    try {
      log("database-write-start");
      if (action === "session-event") registerSessionEvent(db, cli, payload);
      else endSession(db, cli, payload);
      log("database-write-completed");
    } finally {
      db.close();
    }
    log("completed");
  } catch (error) {
    log("error", {
      error: error instanceof Error ? error.message : String(error),
      code: (error as { code?: string }).code,
    });
    console.error(`wr hook: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const commandParser = or(
  command(
    "internal",
    or(
      command(
        "session-event",
        object({ action: constant("internal-session-event"), cli: option("--cli", textValue) }),
      ),
      command(
        "session-end",
        object({ action: constant("internal-session-end"), cli: option("--cli", textValue) }),
      ),
    ),
    { hidden: true },
  ),
  command(
    "config",
    or(
      command("list", object({ action: constant("config-list") }), {
        description: message`List enabled repositories.`,
      }),
      command(
        "enable",
        object({
          action: constant("config-enable"),
          path: withDefault(argument(textValue), "."),
        }),
        { description: message`Enable a repository.` },
      ),
      command(
        "disable",
        object({
          action: constant("config-disable"),
          path: withDefault(argument(textValue), "."),
        }),
        { description: message`Disable a repository.` },
      ),
    ),
    { description: message`Manage repository opt-in.` },
  ),
  command(
    "task",
    or(
      command("list", object({ action: constant("task-list"), ...resourceOptions() }), {
        description: message`List tasks.`,
      }),
      command(
        "add",
        object({
          action: constant("task-add"),
          issue: argument(textValue, { description: message`Task ID.` }),
          title: optional(option("--title", textValue, { description: message`Task title.` })),
        }),
        { description: message`Register an unstarted task.` },
      ),
      command(
        "start",
        object({
          action: constant("task-start"),
          issue: argument(textValue, { description: message`Task ID.` }),
          title: optional(option("--title", textValue, { description: message`Task title.` })),
          worktree: optional(
            option("--worktree", textValue, { description: message`Worktree path.` }),
          ),
          session: optional(
            option("--session", textValue, { description: message`CLI session ID.` }),
          ),
        }),
        { description: message`Start work on a task.` },
      ),
      command(
        "done",
        object({
          action: constant("task-done"),
          issue: optional(argument(textValue, { description: message`Task ID.` })),
          session: optional(
            option("--session", textValue, { description: message`CLI session ID.` }),
          ),
        }),
        { description: message`Complete a task.` },
      ),
      command(
        "cancel",
        object({
          action: constant("task-cancel"),
          issue: optional(argument(textValue, { description: message`Task ID.` })),
          session: optional(
            option("--session", textValue, { description: message`CLI session ID.` }),
          ),
        }),
        { description: message`Cancel a task.` },
      ),
    ),
    { description: message`Manage tasks.` },
  ),
  command(
    "pr",
    or(
      command("list", object({ action: constant("pr-list"), ...resourceOptions() }), {
        description: message`List pull requests.`,
      }),
      command(
        "add",
        object({
          action: constant("pr-add"),
          number: argument(positiveIntegerValue, { description: message`Pull request number.` }),
          task: optional(option("--task", textValue, { description: message`Related task.` })),
          parent: optional(
            option("--parent", positiveIntegerValue, {
              description: message`Parent pull request.`,
            }),
          ),
          session: optional(
            option("--session", textValue, { description: message`CLI session ID.` }),
          ),
        }),
        { description: message`Register a pull request.` },
      ),
      command(
        "remove",
        object({
          action: constant("pr-remove"),
          number: argument(positiveIntegerValue, { description: message`Pull request number.` }),
          task: option("--task", textValue, { description: message`Related task.` }),
        }),
        { description: message`Remove a task relationship from a pull request.` },
      ),
    ),
    { description: message`Manage pull requests.` },
  ),
  command(
    "link",
    or(
      command("list", object({ action: constant("link-list"), ...resourceOptions() }), {
        description: message`List links.`,
      }),
      command(
        "workpad",
        or(
          command(
            "add",
            object({
              action: constant("link-workpad-add"),
              ref: argument(textValue, { description: message`Link reference.` }),
              task: optional(option("--task", textValue, { description: message`Related task.` })),
              session: optional(
                option("--session", textValue, { description: message`CLI session ID.` }),
              ),
            }),
            { description: message`Register a workpad link.` },
          ),
          command(
            "remove",
            object({
              action: constant("link-workpad-remove"),
              ref: argument(textValue, { description: message`Link reference.` }),
              task: optional(option("--task", textValue, { description: message`Related task.` })),
              session: optional(
                option("--session", textValue, { description: message`CLI session ID.` }),
              ),
            }),
            { description: message`Remove a workpad link.` },
          ),
          // TODO: Remove after callers migrate from `wr link workpad REF`.
          object({
            action: constant("legacy-link-workpad-add"),
            ref: argument(textValue, { hidden: true }),
            task: optional(option("--task", textValue, { hidden: true })),
            session: optional(option("--session", textValue, { hidden: true })),
          }),
        ),
        { description: message`Manage workpad links.` },
      ),
      // TODO: Remove after callers migrate from `wr link remove workpad REF`.
      command(
        "remove",
        object({
          action: constant("legacy-link-remove"),
          kind: argument(textValue, { hidden: true }),
          ref: argument(textValue, { hidden: true }),
          task: optional(option("--task", textValue, { hidden: true })),
          session: optional(option("--session", textValue, { hidden: true })),
        }),
        { hidden: true },
      ),
    ),
    { description: message`Manage task links.` },
  ),
  command(
    "session",
    command("list", object({ action: constant("session-list"), ...resourceOptions() }), {
      description: message`List CLI sessions.`,
    }),
    { description: message`Manage CLI sessions.` },
  ),
  command(
    "checkout",
    command("list", object({ action: constant("checkout-list"), ...resourceOptions() }), {
      description: message`List Git checkouts.`,
    }),
    { description: message`Manage Git checkouts.` },
  ),
  command(
    "execution",
    command("list", object({ action: constant("execution-list"), ...resourceOptions() }), {
      description: message`List task executions.`,
    }),
    { description: message`Manage task executions.` },
  ),
  command(
    "branch",
    command("list", object({ action: constant("branch-list"), ...resourceOptions() }), {
      description: message`List Git branches.`,
    }),
    { description: message`Manage Git branches.` },
  ),
  command(
    "repo",
    command("list", object({ action: constant("repo-list"), ...resourceOptions() }), {
      description: message`List repositories.`,
    }),
    { description: message`Manage repositories.` },
  ),
  command(
    "run",
    or(
      command("list", object({ action: constant("run-list"), ...resourceOptions() }), {
        description: message`List session runs.`,
      }),
      command(
        "focus",
        object({
          action: constant("run-focus"),
          target: argument(textValue, { description: message`CLI session or run ID.` }),
        }),
        { description: message`Focus the iTerm2 pane for a session run.` },
      ),
    ),
    { description: message`Manage session runs.` },
  ),
  command(
    "terminal",
    or(
      command("list", object({ action: constant("terminal-list"), ...resourceOptions() }), {
        description: message`List terminals.`,
      }),
      command(
        "focus",
        object({
          action: constant("terminal-focus"),
          target: argument(textValue, { description: message`Terminal ID.` }),
        }),
        { description: message`Focus an iTerm2 pane.` },
      ),
    ),
    { description: message`Manage iTerm2 terminals.` },
  ),
  command(
    "show",
    object({
      action: constant("show"),
      task: optional(option("--task", textValue, { description: message`Select a task.` })),
      worktree: optional(
        option("--worktree", textValue, { description: message`Select a worktree.` }),
      ),
      session: optional(option("--session", textValue, { description: message`CLI session ID.` })),
      json: option("--json", { description: message`Output JSON.` }),
    }),
    { description: message`Show relationships for the current context.` },
  ),
  command(
    "sync",
    object({
      action: constant("sync"),
      session: optional(option("--session", textValue, { description: message`CLI session ID.` })),
    }),
    { description: message`Synchronize pull-request relationships.` },
  ),
  or(
    command("doctor", object({ action: constant("doctor") }), {
      description: message`Inspect the local wr installation.`,
    }),
    command("ui", object({ action: constant("ui") }), {
      description: message`Search active focus targets.`,
    }),
    // TODO: Remove these plural resource commands after callers migrate to
    // `wr <singular-resource> list` and singular `run|terminal focus` commands.
    or(
      command("tasks", object({ action: constant("legacy-tasks"), ...resourceOptions() }), {
        hidden: true,
      }),
      command("sessions", object({ action: constant("legacy-sessions"), ...resourceOptions() }), {
        hidden: true,
      }),
      command("checkouts", object({ action: constant("legacy-checkouts"), ...resourceOptions() }), {
        hidden: true,
      }),
      command(
        "executions",
        object({ action: constant("legacy-executions"), ...resourceOptions() }),
        {
          hidden: true,
        },
      ),
      command("links", object({ action: constant("legacy-links"), ...resourceOptions() }), {
        hidden: true,
      }),
      command("prs", object({ action: constant("legacy-prs"), ...resourceOptions() }), {
        hidden: true,
      }),
      command("branches", object({ action: constant("legacy-branches"), ...resourceOptions() }), {
        hidden: true,
      }),
      command("repos", object({ action: constant("legacy-repos"), ...resourceOptions() }), {
        hidden: true,
      }),
      command(
        "runs",
        or(
          command(
            "focus",
            object({ action: constant("legacy-runs-focus"), target: argument(textValue) }),
            { hidden: true },
          ),
          object({ action: constant("legacy-runs"), ...resourceOptions() }),
        ),
        { hidden: true },
      ),
      command(
        "terminals",
        or(
          command(
            "focus",
            object({ action: constant("legacy-terminals-focus"), target: argument(textValue) }),
            { hidden: true },
          ),
          object({ action: constant("legacy-terminals"), ...resourceOptions() }),
        ),
        { hidden: true },
      ),
    ),
  ),
);

const runOptions = {
  programName: "wr",
  brief: message`Relationship ledger for tasks and CLI sessions.`,
  help: { command: true, option: { names: ["-h", "--help"] } },
  commandList: "top-level",
} as const;

try {
  const entrypointIndex = process.argv[1] && resolve(process.argv[1]) === Bun.main ? 2 : 1;
  const args = process.argv.slice(entrypointIndex);
  const cli = run(commandParser, {
    ...runOptions,
    args: args.length === 0 ? ["--help"] : args,
  });

  switch (cli.action) {
    case "internal-session-event":
      await runInternal("session-event", cli.cli);
      break;
    case "internal-session-end":
      await runInternal("session-end", cli.cli);
      break;
    case "config-list": {
      const repositories = readConfig().repositories;
      console.log(repositories.length === 0 ? "No enabled repositories" : repositories.join("\n"));
      break;
    }
    case "config-enable": {
      const result = enableRepository(cli.path);
      console.log(`${result.changed ? "enabled" : "already enabled"} ${result.repoRoot}`);
      break;
    }
    case "config-disable": {
      const result = disableRepository(cli.path);
      console.log(`${result.changed ? "disabled" : "already disabled"} ${result.repoRoot}`);
      break;
    }
    case "task-list":
      runResource("tasks", cli);
      break;
    case "task-add":
      requireEnabledRepository(process.cwd());
      withDb((db) => {
        const result = addTask(db, cli.issue, cli.title);
        console.log(`registered ${result.issue} status=${result.status}`);
      });
      break;
    case "task-start":
      requireEnabledRepository(process.cwd());
      if (cli.worktree) requireEnabledRepository(cli.worktree);
      withDb((db) => {
        const current = resolveCurrentContext(db, process.cwd(), cli.session);
        const result = startTask(db, current, cli.issue, cli);
        if (result.reopened) console.error(`reopened ${cli.issue} (was done or cancelled)`);
        console.log(`started ${cli.issue} execution=${result.executionId}`);
      });
      break;
    case "task-done":
      requireEnabledRepository(process.cwd());
      withDb((db) => {
        const current = resolveCurrentContext(db, process.cwd(), cli.session);
        const result = doneTask(db, current, cli.issue);
        console.log(
          `done ${result.issue} finished=${result.finished} abandoned=${result.abandoned}`,
        );
      });
      break;
    case "task-cancel":
      requireEnabledRepository(process.cwd());
      withDb((db) => {
        const current = cli.issue ? null : resolveCurrentContext(db, process.cwd(), cli.session);
        const result = cancelTask(db, current, cli.issue);
        console.log(`cancelled ${result.issue} abandoned=${result.abandoned}`);
      });
      break;
    case "pr-list":
      runResource("prs", cli);
      break;
    case "pr-add":
      requireEnabledRepository(process.cwd());
      withDb((db) => {
        const current = resolveCurrentContext(db, process.cwd(), cli.session);
        const result = addPullRequest(db, current, cli.number, {
          task: cli.task,
          parent: cli.parent,
        });
        if (result.warning) console.error(`warning: ${result.warning}`);
        console.log(`added ${result.repo}#${cli.number}`);
      });
      break;
    case "pr-remove":
      requireEnabledRepository(process.cwd());
      withDb((db) => {
        const result = removePullRequest(db, cli.number, cli.task);
        console.log(`removed ${result.repo}#${cli.number} task=${result.issue}`);
      });
      break;
    case "link-list":
      runResource("links", cli);
      break;
    case "link-workpad-add":
    case "legacy-link-workpad-add":
      requireEnabledRepository(process.cwd());
      withDb((db) => {
        const current = resolveCurrentContext(db, process.cwd(), cli.session);
        const result = addWorkpadLink(db, current, cli.ref, cli.task);
        console.log(`linked workpad=${result.ref} task=${result.issue ?? "none"}`);
      });
      break;
    case "link-workpad-remove":
      requireEnabledRepository(process.cwd());
      withDb((db) => {
        const current = resolveCurrentContext(db, process.cwd(), cli.session);
        const result = removeWorkpadLink(db, current, cli.ref, cli.task);
        console.log(`removed workpad=${result.ref} task=${result.issue ?? "none"}`);
      });
      break;
    case "legacy-link-remove":
      if (cli.kind !== "workpad") throw new Error(`Unknown link kind: ${cli.kind}`);
      requireEnabledRepository(process.cwd());
      withDb((db) => {
        const current = resolveCurrentContext(db, process.cwd(), cli.session);
        const result = removeWorkpadLink(db, current, cli.ref, cli.task);
        console.log(`removed workpad=${result.ref} task=${result.issue ?? "none"}`);
      });
      break;
    case "session-list":
      runResource("sessions", cli);
      break;
    case "checkout-list":
      runResource("checkouts", cli);
      break;
    case "execution-list":
      runResource("executions", cli);
      break;
    case "branch-list":
      runResource("branches", cli);
      break;
    case "repo-list":
      runResource("repos", cli);
      break;
    case "run-list":
      runResource("runs", cli);
      break;
    case "run-focus":
      focusTerminal(cli.target, true);
      break;
    case "terminal-list":
      runResource("terminals", cli);
      break;
    case "terminal-focus":
      focusTerminal(cli.target, false);
      break;
    case "show":
      if (cli.task && cli.worktree)
        throw new Error("--task and --worktree cannot be used together");
      if (!cli.task && !cli.worktree) requireEnabledRepository(process.cwd());
      withDb((db) => {
        const current =
          cli.task || cli.worktree ? null : resolveCurrentContext(db, process.cwd(), cli.session);
        console.log(show(db, current, cli));
      });
      break;
    case "sync":
      requireEnabledRepository(process.cwd());
      withDb((db) => {
        const current = resolveCurrentContext(db, process.cwd(), cli.session);
        const result = syncPullRequests(db, current);
        console.log(
          `synced checkouts=${result.checkouts} prs=${result.pullRequests} linked=${result.linked} skipped=${result.skipped}`,
        );
      });
      break;
    case "doctor":
      runDoctor();
      break;
    case "ui": {
      const db = openDb(process.env.WR_DB_PATH);
      try {
        await render(createElement(WrUi, { targets: queryFocusTargets(db) })).waitUntilExit();
      } finally {
        db.close();
      }
      break;
    }
    case "legacy-tasks":
      runResource("tasks", cli);
      break;
    case "legacy-sessions":
      runResource("sessions", cli);
      break;
    case "legacy-checkouts":
      runResource("checkouts", cli);
      break;
    case "legacy-executions":
      runResource("executions", cli);
      break;
    case "legacy-links":
      runResource("links", cli);
      break;
    case "legacy-prs":
      runResource("prs", cli);
      break;
    case "legacy-branches":
      runResource("branches", cli);
      break;
    case "legacy-repos":
      runResource("repos", cli);
      break;
    case "legacy-runs":
      runResource("runs", cli);
      break;
    case "legacy-runs-focus":
      focusTerminal(cli.target, true);
      break;
    case "legacy-terminals":
      runResource("terminals", cli);
      break;
    case "legacy-terminals-focus":
      focusTerminal(cli.target, false);
      break;
  }
} catch (error) {
  console.error(`wr: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
