#!/usr/bin/env bun
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
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
import type { FocusTarget, PullRequestInput, SessionLineage, ShowTask } from "./api.ts";
import { ApiClient } from "./client.ts";
import {
  disableRepository,
  enableRepository,
  isRepositoryEnabled,
  readConfig,
  requireEnabledRepository,
  setServerUrl,
} from "./config.ts";
import {
  appendClaudeEnvironment,
  clearDevinSession,
  currentContext,
  findCurrentSession,
  findDevinProcessPid,
  findParentSession,
  findSessionIdentities,
  normalizeStoredCheckout,
  normalizeStoredPath,
  parseHookPayload,
  parseToolHookPayload,
  writeDevinSession,
  type Cli,
} from "./context.ts";
import { discoverCheckout } from "./git.ts";
import { renderResource, renderSessionLineage, renderShow } from "./output.ts";
import { isCurrentResource, RESOURCE_FIELDS, type ResourceName } from "./resources.ts";
import { WrUi } from "./ui.tsx";
import {
  CliSchema,
  ExecutionStatusSchema,
  extractPullRequestUrls,
  extractSlackThreadUrls,
  isPullRequestCreateCommand,
  isPullRequestMergeCommand,
  ITermSessionListSchema,
  NonEmptyStringSchema,
  PositiveIntegerSchema,
  PullRequestSchema,
  PullRequestStateSchema,
  RepositorySchema,
  RepositoryStatusSchema,
  RunStatusSchema,
  ServerUrlSchema,
  TaskStatusSchema,
  toolResponseText,
  type ToolHookPayload,
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
  all?: boolean;
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

function client(): ApiClient {
  return new ApiClient(readConfig());
}

function openServer(): void {
  const configuredUrl = process.env.WR_SERVER_URL ?? readConfig().serverUrl;
  if (!configuredUrl) throw new Error("Server is not configured; run wr config server URL");
  const serverUrl = v.parse(ServerUrlSchema, configuredUrl);
  const result = Bun.spawnSync(["open", serverUrl], { stdout: "ignore", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error("Could not open the wr server");
  console.log(`opened ${serverUrl}`);
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
    if (resource === "prs") return v.parse(PullRequestStateSchema, value);
    if (resource === "sessions" || resource === "runs" || resource === "terminals")
      return v.parse(RunStatusSchema, value);
    if (resource === "repos") return v.parse(RepositoryStatusSchema, value);
  } catch {
    if (resource === "tasks") throw new Error("--status must be open, active, done, or cancelled");
    if (resource === "executions")
      throw new Error("--status must be active, finished, or abandoned");
    if (resource === "prs") throw new Error("--status must be open, closed, or merged");
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
    all: option("--all", { description: message`Include all devices and historical records.` }),
    // TODO: Remove after callers migrate to `--all`; this also keeps the old
    // repository-wide listing flag working during the transition.
    global: option("--global", {
      description: message`Include all repositories, devices, and historical records.`,
    }),
    limit: optional(
      option("--limit", positiveIntegerValue, {
        description: message`Limit the number of records.`,
      }),
    ),
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

async function runResource(resource: ResourceName, values: ResourceOptions): Promise<void> {
  if (values.json === true) {
    if (values.jq) throw new Error("--jq requires --json FIELDS");
    console.log(RESOURCE_FIELDS[resource].join("\n"));
    return;
  }
  if (values.global && values.repo) throw new Error("--global and --repo cannot be used together");
  if (values.kind !== undefined && resource !== "links")
    throw new Error(`--kind is not supported by ${resource}`);

  const all = values.all || values.global;
  const worktree = values.worktree ? discoverCheckout(values.worktree, true)! : undefined;
  const repo = values.repo ? discoverCheckout(values.repo, true)! : undefined;
  const repoRoot = values.global
    ? undefined
    : normalizeStoredPath(
        repo?.repoRoot ?? worktree?.repoRoot ?? discoverCheckout(process.cwd())?.repoRoot ?? "",
      );
  const endpoint =
    resource === "tasks"
      ? "/api/tasks"
      : resource === "prs"
        ? "/api/pull-requests"
        : `/api/device/resources/${resource}`;
  const path = `${endpoint}${all ? "?all=true" : ""}`;
  const rows = await client().request<Array<Record<string, unknown>>>(path);
  const status = resourceStatus(resource, values.status);
  const matching = rows.filter((row) => {
    const repoRoots = Array.isArray(row.repoRoots) ? row.repoRoots : [];
    const worktreePaths = Array.isArray(row.worktreePaths) ? row.worktreePaths : [];
    return (
      (!values.task || row.linearIssueId === values.task) &&
      (!values.session || String(row.session ?? "").includes(values.session)) &&
      (!values.run || row.id === values.run || row.runId === values.run) &&
      (!values.checkout || row.id === values.checkout || row.checkoutId === values.checkout) &&
      (!values.execution || row.id === values.execution) &&
      (!values.link || row.id === values.link) &&
      (!values.terminal || String(row.itermSessionId ?? "").endsWith(values.terminal)) &&
      (!repoRoot || row.repoRoot === repoRoot || repoRoots.includes(repoRoot)) &&
      (!worktree ||
        row.worktreePath === normalizeStoredPath(worktree.worktreePath) ||
        worktreePaths.includes(normalizeStoredPath(worktree.worktreePath))) &&
      (!values.branch || row.branch === values.branch || row.headBranch === values.branch) &&
      (!values.pr || row.number === values.pr) &&
      (!status || row.status === status || row.state === status) &&
      (!values.kind || row.kind === values.kind)
    );
  });
  const current =
    all || values.status !== undefined
      ? matching
      : matching.filter((row) => isCurrentResource(resource, row));
  const nonCurrentCount = matching.length - current.length;
  let visible = values.limit ? current.slice(0, values.limit) : current;
  if (resource === "runs" || resource === "terminals") {
    const live = getLiveTerminalIds();
    visible = visible.map((row) => ({
      ...row,
      terminalId: String(row.itermSessionId ?? "")
        .split(":")
        .at(-1),
      pane: paneStatus(row.itermSessionId, live),
    }));
  }
  if (resource === "repos") {
    const enabled = new Set(readConfig().repositories);
    visible = visible.map((row) => ({ ...row, enabled: enabled.has(String(row.repoRoot)) }));
  }
  console.log(
    renderResource(
      resource,
      visible,
      typeof values.json === "string" ? values.json : undefined,
      values.jq,
      nonCurrentCount,
    ),
  );
}

async function syncSessionRuns(): Promise<void> {
  const runs = await client().request<
    Array<{ id: string; status: string; itermSessionId: string | null }>
  >("/api/device/resources/runs");
  const liveTerminalIds = getLiveTerminalIds();
  if (!liveTerminalIds) throw new Error("Could not list iTerm2 sessions");
  const result = await client().request<{ ended: number }>("/api/runs/sync", {
    method: "POST",
    body: JSON.stringify({
      candidateRunIds: runs
        .filter((sessionRun) => sessionRun.status === "active" && sessionRun.itermSessionId)
        .map((sessionRun) => sessionRun.id),
      liveTerminalIds: [...liveTerminalIds],
    }),
  });
  console.log(`synced runs=${result.ended}`);
}

function hookStatus(contents: string, cli: Cli): string {
  const missing = (
    [
      ["event", `wr internal session-event --cli ${cli}`],
      ["prompt", `wr internal session-prompt --cli ${cli}`],
      ["end", `wr internal session-end --cli ${cli}`],
      ["tool", `wr internal tool-event --cli ${cli}`],
    ] as const
  )
    .filter(([, hookCommand]) => !contents.includes(hookCommand))
    .map(([eventName]) => eventName);
  return missing.length === 0 ? "configured" : `missing:${missing.join(",")}`;
}

async function runDoctor(): Promise<void> {
  const checkout = discoverCheckout(process.cwd());
  const lines: string[] = [];
  const health = await client().request<{ ok: boolean; principal: string }>("/api/health");
  lines.push(`server status=${health.ok ? "ok" : "failed"} principal=${health.principal}`);
  const identity = findCurrentSession();
  lines.push(
    identity
      ? `session identity=${identity.cli}:${identity.externalSessionId}`
      : "session status=not-detected",
  );
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
    const devinPaths = [
      join(home, ".config", "devin", "config.json"),
      join(process.cwd(), ".devin", "hooks.v1.json"),
      join(process.cwd(), ".devin", "config.json"),
    ];
    const piPaths = [
      join(home, ".omp", "agent", "hooks", "pre", "wr.ts"),
      join(process.cwd(), ".omp", "hooks", "pre", "wr.ts"),
    ];
    const claude = existsSync(claudePath) ? readFileSync(claudePath, "utf8") : "";
    const codex = existsSync(codexPath) ? readFileSync(codexPath, "utf8") : "";
    const devin = devinPaths
      .filter((path) => existsSync(path))
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    const pi = piPaths
      .filter((path) => existsSync(path))
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    const piStatus =
      pi.includes("ctx.sessionManager.getSessionId()") && pi.includes(`"--cli", "pi"`)
        ? "configured"
        : "missing:adapter";
    lines.push(
      `hooks claude=${hookStatus(claude, "claude")} codex=${hookStatus(codex, "codex")} devin=${hookStatus(devin, "devin")} pi=${piStatus}`,
    );
  } else {
    lines.push("hooks claude=unknown codex=unknown devin=unknown pi=unknown");
  }
  console.log(lines.join("\n"));
}

async function focusTerminal(target: string, resolveRun: boolean): Promise<void> {
  const terminalId = resolveRun
    ? (
        await client().request<FocusTarget[]>(
          `/api/focus-targets?run=${encodeURIComponent(target)}`,
        )
      )
        .find((row) => row.id === target || row.session.includes(target))
        ?.itermSessionId.split(":")
        .at(-1)
    : target.split(":").at(-1);
  if (!terminalId) throw new Error(`No terminal found: ${target}`);
  const result = Bun.spawnSync(["it2", "session", "focus", terminalId], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0)
    throw new Error(result.stderr.toString().trim() || "Could not focus the iTerm2 pane");
  console.log(`focused terminal=${terminalId}`);
}

async function runInternal(
  action: "session-event" | "session-prompt" | "session-end" | "tool-event",
  cliValue: string,
): Promise<void> {
  const startedAt = performance.now();
  const operationId = crypto.randomUUID();
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

  log("spawned");
  const payloadText = await Bun.stdin.text();
  log("received");

  try {
    log("parse-start");
    const result = v.safeParse(CliSchema, cliValue);
    if (!result.success) throw new Error("--cli must be pi, codex, claude, or devin");
    const cli: Cli = result.output;
    const parsedPayload =
      action === "tool-event"
        ? parseToolHookPayload(
            payloadText,
            cli === "devin" ? process.env.DEVIN_PROJECT_DIR : undefined,
          )
        : parseHookPayload(
            payloadText,
            cli === "devin" ? process.env.DEVIN_PROJECT_DIR : undefined,
          );
    const payload =
      cli === "pi" && process.env.PI_SESSION_ID
        ? { ...parsedPayload, session_id: process.env.PI_SESSION_ID }
        : parsedPayload;
    const hookSession = { cli, externalSessionId: payload.session_id };
    const parentCandidate = findParentSession();
    const parentSession =
      parentCandidate &&
      (parentCandidate.cli !== hookSession.cli ||
        parentCandidate.externalSessionId !== hookSession.externalSessionId)
        ? parentCandidate
        : undefined;
    const relatedSessions = findSessionIdentities(process.env, payload.cwd, parentSession).filter(
      (candidate) =>
        candidate.cli !== hookSession.cli ||
        candidate.externalSessionId !== hookSession.externalSessionId,
    );
    log("parse-completed", { source: "source" in payload ? payload.source : undefined });

    // PostToolUse fires for every tool call, so reject on the payload alone before
    // isRepositoryEnabled spawns git through discoverCheckout.
    if (action === "tool-event") {
      const toolPayload = payload as ToolHookPayload;
      const toolCommand = toolPayload.tool_input?.command;
      if (
        !toolCommand ||
        (!isPullRequestCreateCommand(toolCommand) && !isPullRequestMergeCommand(toolCommand))
      ) {
        log("tool-event-ignored", { reason: "not-pull-request-command" });
        return;
      }
      log("repository-check-start");
      if (!isRepositoryEnabled(toolPayload.cwd)) {
        log("repository-disabled");
        return;
      }
      log("repository-check-completed");
      log("request-start");
      const cwd = realpathSync(toolPayload.cwd);
      const urls = extractPullRequestUrls(toolResponseText(toolPayload.tool_response));
      const pullRequest = isPullRequestCreateCommand(toolCommand)
        ? urls.length === 1
          ? loadPullRequest(urls[0]!.repo, urls[0]!.number, cwd)
          : null
        : loadPullRequest(
            toolCommand.match(/(?:^|\s)(?:-R|--repo)\s+([^\s;&|]+)/)?.[1] ?? repositoryName(cwd),
            toolCommand.match(/\bgh\s+pr\s+merge(?:\s+((?!--)[^\s;&|]+))?/)?.[1],
            cwd,
          );
      if (!pullRequest) {
        log("tool-event-ignored", { reason: "pull-request-url-count", count: urls.length });
        return;
      }
      await client().request("/api/pull-requests", {
        method: "POST",
        body: JSON.stringify({
          pullRequest,
          context: {
            session: hookSession,
            relatedSessions,
            parentSession,
            runId: process.env.WR_SESSION_RUN_ID,
            checkout: normalizeStoredCheckout(discoverCheckout(cwd)),
            terminalId: process.env.TERM_SESSION_ID,
          },
        }),
      });
      log("request-completed");
      log("completed");
      return;
    }

    const hookPayload = payload as ReturnType<typeof parseHookPayload>;
    if (action !== "session-end") {
      log("repository-check-start");
      if (!isRepositoryEnabled(hookPayload.cwd)) {
        log("repository-disabled");
        return;
      }
      log("repository-check-completed");
    }
    log("request-start");
    if (action === "session-prompt" && !hookPayload.prompt) {
      throw new Error("UserPromptSubmit payload must include prompt");
    }
    const cwd = realpathSync(hookPayload.cwd);
    const checkout =
      action === "session-prompt" ? undefined : normalizeStoredCheckout(discoverCheckout(cwd));
    let endpoint: string;
    switch (action) {
      case "session-event":
        endpoint = "/api/session-events";
        break;
      case "session-prompt":
        endpoint = "/api/session-prompts";
        break;
      case "session-end":
        endpoint = "/api/session-ends";
        break;
    }
    const response = await client().request<{ runId?: string | null }>(endpoint, {
      method: "POST",
      body: JSON.stringify({
        cli,
        payload: { ...hookPayload, cwd: normalizeStoredPath(cwd) },
        relatedSessions,
        parentSession,
        ...(checkout === undefined ? {} : { checkout }),
        terminalId: process.env.TERM_SESSION_ID,
      }),
    });
    if (action === "session-event" && cli === "claude") {
      appendClaudeEnvironment(
        process.env.CLAUDE_ENV_FILE,
        { cli, externalSessionId: hookPayload.session_id },
        response.runId ?? null,
      );
    }
    if (action === "session-event" && cli === "devin") {
      writeDevinSession(
        { cli, externalSessionId: hookPayload.session_id },
        response.runId ?? null,
        cwd,
        findDevinProcessPid(),
      );
    }
    if (action === "session-end" && cli === "devin") {
      clearDevinSession(hookPayload.session_id, findDevinProcessPid());
    }
    if (action === "session-prompt") {
      await Promise.all(
        extractSlackThreadUrls(hookPayload.prompt!).map(async (url) => {
          try {
            await client().request("/api/conversation-links", {
              method: "POST",
              body: JSON.stringify({
                url,
                context: {
                  session: hookSession,
                  relatedSessions,
                  parentSession,
                  runId: process.env.WR_SESSION_RUN_ID,
                  checkout: null,
                  terminalId: process.env.TERM_SESSION_ID,
                },
              }),
            });
            log("conversation-link-completed", { url });
          } catch (error) {
            log("conversation-link-error", {
              url,
              error: error instanceof Error ? error.message : String(error),
              code: (error as { code?: string }).code,
            });
          }
        }),
      );
    }
    log("request-completed");
    log("completed");
  } catch (error) {
    log("error", {
      error: error instanceof Error ? error.message : String(error),
      code: (error as { code?: string }).code,
    });
    console.error(`wr hook: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function runGh(args: string[], cwd = process.cwd()): string {
  const result = Bun.spawnSync(["gh", ...args], {
    cwd,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim() || "gh failed");
  return result.stdout.toString().trim();
}

function repositoryName(cwd = process.cwd()): string {
  return v.parse(
    RepositorySchema,
    JSON.parse(runGh(["repo", "view", "--json", "nameWithOwner"], cwd)),
  ).nameWithOwner;
}

function loadPullRequest(
  repo: string,
  number?: string | number,
  cwd = process.cwd(),
): PullRequestInput {
  const value = v.parse(
    PullRequestSchema,
    JSON.parse(
      runGh(
        [
          "pr",
          "view",
          ...(number === undefined ? [] : [String(number)]),
          "--repo",
          repo,
          "--json",
          "number,url,headRefName,baseRefName,state",
        ],
        cwd,
      ),
    ),
  );
  return {
    repo: new URL(value.url).pathname.slice(1).replace(/\/pull\/\d+$/, ""),
    number: value.number,
    url: value.url,
    headBranch: value.headRefName,
    baseBranch: value.baseRefName,
    state: value.state,
  };
}

async function syncPullRequestStates(all: boolean): Promise<number> {
  const api = client();
  const targets = await api.request<Array<{ repo: string; number: number }>>(
    `/api/pull-requests/sync-targets?all=${all}`,
  );
  const pullRequests = targets.map((target) => loadPullRequest(target.repo, target.number));
  await api.request("/api/pull-requests/sync", {
    method: "POST",
    body: JSON.stringify({ pullRequests }),
  });
  return pullRequests.length;
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
        "session-prompt",
        object({ action: constant("internal-session-prompt"), cli: option("--cli", textValue) }),
      ),
      command(
        "session-end",
        object({ action: constant("internal-session-end"), cli: option("--cli", textValue) }),
      ),
      command(
        "tool-event",
        object({ action: constant("internal-tool-event"), cli: option("--cli", textValue) }),
      ),
    ),
    { hidden: true },
  ),
  or(
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
        command("server", object({ action: constant("config-server"), url: argument(textValue) }), {
          description: message`Set the Worker URL.`,
        }),
      ),
      { description: message`Manage repository opt-in.` },
    ),
    command(
      "server",
      command("open", object({ action: constant("server-open") }), {
        description: message`Open the configured Worker in a browser.`,
      }),
      { description: message`Open the wr server.` },
    ),
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
      command(
        "sync",
        object({
          action: constant("pr-sync"),
          all: option("--all", { description: message`Include closed and merged pull requests.` }),
        }),
        { description: message`Synchronize registered pull request states.` },
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
      command(
        "conversation",
        or(
          command(
            "add",
            object({
              action: constant("link-conversation-add"),
              url: argument(textValue, { description: message`Slack thread URL.` }),
              session: optional(
                option("--session", textValue, { description: message`CLI session ID.` }),
              ),
            }),
            { description: message`Register a conversation link.` },
          ),
          command(
            "remove",
            object({
              action: constant("link-conversation-remove"),
              url: argument(textValue, { description: message`Slack thread URL.` }),
              session: optional(
                option("--session", textValue, { description: message`CLI session ID.` }),
              ),
            }),
            { description: message`Remove a conversation link.` },
          ),
        ),
        { description: message`Manage conversation links.` },
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
    or(
      command("list", object({ action: constant("session-list"), ...resourceOptions() }), {
        description: message`List CLI sessions.`,
      }),
      command(
        "tree",
        object({
          action: constant("session-tree"),
          session: option("--session", textValue, { description: message`CLI session identity.` }),
          json: option("--json", { description: message`Output the lineage as JSON.` }),
        }),
        { description: message`Show session ancestors and descendants.` },
      ),
    ),
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
      command("sync", object({ action: constant("run-sync") }), {
        description: message`End runs whose iTerm2 sessions no longer exist.`,
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
    case "internal-session-prompt":
      await runInternal("session-prompt", cli.cli);
      break;
    case "internal-session-end":
      await runInternal("session-end", cli.cli);
      break;
    case "internal-tool-event":
      await runInternal("tool-event", cli.cli);
      break;
    case "config-list": {
      const config = readConfig();
      console.log(`server ${config.serverUrl ?? "not configured"}`);
      console.log(`device-id ${config.deviceId}`);
      console.log(
        config.repositories.length === 0
          ? "No enabled repositories"
          : config.repositories.join("\n"),
      );
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
    case "config-server":
      setServerUrl(cli.url);
      console.log(`server ${cli.url}`);
      break;
    case "server-open":
      openServer();
      break;
    case "task-list":
      await runResource("tasks", cli);
      break;
    case "task-add": {
      requireEnabledRepository(process.cwd());
      const result = await client().request<{ issue: string; status: string }>("/api/tasks", {
        method: "POST",
        body: JSON.stringify({ issue: cli.issue, title: cli.title }),
      });
      console.log(`registered ${result.issue} status=${result.status}`);
      break;
    }
    case "task-start": {
      requireEnabledRepository(process.cwd());
      if (cli.worktree) requireEnabledRepository(cli.worktree);
      const context = currentContext(cli.worktree ?? process.cwd(), cli.session);
      const result = await client().request<{ executionId: string; reopened: boolean }>(
        `/api/tasks/${encodeURIComponent(cli.issue)}/start`,
        {
          method: "POST",
          body: JSON.stringify({ context, title: cli.title }),
        },
      );
      if (result.reopened) console.error(`reopened ${cli.issue} (was done or cancelled)`);
      console.log(`started ${cli.issue} execution=${result.executionId}`);
      break;
    }
    case "task-done": {
      requireEnabledRepository(process.cwd());
      const endpoint = cli.issue
        ? `/api/tasks/${encodeURIComponent(cli.issue)}/done`
        : "/api/tasks/current/done";
      const result = await client().request<{ issue: string; finished: number; abandoned: number }>(
        endpoint,
        {
          method: "POST",
          body: JSON.stringify({ context: currentContext(process.cwd(), cli.session) }),
        },
      );
      console.log(`done ${result.issue} finished=${result.finished} abandoned=${result.abandoned}`);
      break;
    }
    case "task-cancel": {
      requireEnabledRepository(process.cwd());
      const endpoint = cli.issue
        ? `/api/tasks/${encodeURIComponent(cli.issue)}/cancel`
        : "/api/tasks/current/cancel";
      const result = await client().request<{ issue: string; abandoned: number }>(endpoint, {
        method: "POST",
        body: JSON.stringify({ context: currentContext(process.cwd(), cli.session) }),
      });
      console.log(`cancelled ${result.issue} abandoned=${result.abandoned}`);
      break;
    }
    case "pr-list":
      await runResource("prs", cli);
      break;
    case "pr-add": {
      requireEnabledRepository(process.cwd());
      const repo = repositoryName();
      await client().request("/api/pull-requests", {
        method: "POST",
        body: JSON.stringify({
          pullRequest: loadPullRequest(repo, cli.number),
          task: cli.task,
          parent: cli.parent,
          parentPullRequest: cli.parent ? loadPullRequest(repo, cli.parent) : undefined,
          context: currentContext(process.cwd(), cli.session),
        }),
      });
      console.log(`added ${repo}#${cli.number}`);
      break;
    }
    case "pr-remove": {
      requireEnabledRepository(process.cwd());
      const repo = repositoryName();
      await client().request(
        `/api/pull-requests/${encodeURIComponent(repo)}/${cli.number}/tasks/${encodeURIComponent(cli.task)}`,
        { method: "DELETE" },
      );
      console.log(`removed ${repo}#${cli.number} task=${cli.task}`);
      break;
    }
    case "pr-sync": {
      const count = await syncPullRequestStates(cli.all);
      console.log(`synced prs=${count}`);
      break;
    }
    case "link-list":
      await runResource("links", cli);
      break;
    case "link-workpad-add":
    case "legacy-link-workpad-add": {
      requireEnabledRepository(process.cwd());
      const ref = normalizeStoredPath(existsSync(cli.ref) ? realpathSync(cli.ref) : cli.ref);
      await client().request("/api/workpad-links", {
        method: "POST",
        body: JSON.stringify({
          ref,
          task: cli.task,
          context: currentContext(process.cwd(), cli.session),
        }),
      });
      console.log(`linked workpad=${ref} task=${cli.task ?? "none"}`);
      break;
    }
    case "link-workpad-remove": {
      requireEnabledRepository(process.cwd());
      const ref = normalizeStoredPath(existsSync(cli.ref) ? realpathSync(cli.ref) : cli.ref);
      await client().request("/api/workpad-links", {
        method: "DELETE",
        body: JSON.stringify({
          ref,
          task: cli.task,
          context: currentContext(process.cwd(), cli.session),
        }),
      });
      console.log(`removed workpad=${ref} task=${cli.task ?? "none"}`);
      break;
    }
    case "link-conversation-add":
      requireEnabledRepository(process.cwd());
      await client().request("/api/conversation-links", {
        method: "POST",
        body: JSON.stringify({
          url: cli.url,
          context: currentContext(process.cwd(), cli.session),
        }),
      });
      console.log(`linked conversation=${cli.url}`);
      break;
    case "link-conversation-remove":
      requireEnabledRepository(process.cwd());
      await client().request("/api/conversation-links", {
        method: "DELETE",
        body: JSON.stringify({
          url: cli.url,
          context: currentContext(process.cwd(), cli.session),
        }),
      });
      console.log(`removed conversation=${cli.url} session=${cli.session ?? "current"}`);
      break;
    case "legacy-link-remove":
      if (cli.kind !== "workpad") throw new Error(`Unknown link kind: ${cli.kind}`);
      requireEnabledRepository(process.cwd());
      await client().request("/api/workpad-links", {
        method: "DELETE",
        body: JSON.stringify({
          ref: normalizeStoredPath(existsSync(cli.ref) ? realpathSync(cli.ref) : cli.ref),
          task: cli.task,
          context: currentContext(process.cwd(), cli.session),
        }),
      });
      console.log(`removed workpad=${cli.ref} task=${cli.task ?? "none"}`);
      break;
    case "session-list":
      await runResource("sessions", cli);
      break;
    case "session-tree": {
      const lineage = await client().request<SessionLineage>(
        `/api/session-lineage?session=${encodeURIComponent(cli.session)}`,
      );
      console.log(cli.json ? JSON.stringify(lineage, null, 2) : renderSessionLineage(lineage));
      break;
    }
    case "checkout-list":
      await runResource("checkouts", cli);
      break;
    case "execution-list":
      await runResource("executions", cli);
      break;
    case "branch-list":
      await runResource("branches", cli);
      break;
    case "repo-list":
      await runResource("repos", cli);
      break;
    case "run-list":
      await runResource("runs", cli);
      break;
    case "run-sync":
      await syncSessionRuns();
      break;
    case "run-focus":
      await focusTerminal(cli.target, true);
      break;
    case "terminal-list":
      await runResource("terminals", cli);
      break;
    case "terminal-focus":
      await focusTerminal(cli.target, false);
      break;
    case "show": {
      if (cli.task && cli.worktree)
        throw new Error("--task and --worktree cannot be used together");
      if (!cli.task && !cli.worktree) requireEnabledRepository(process.cwd());
      const params = new URLSearchParams();
      if (cli.task) params.set("task", cli.task);
      if (cli.worktree)
        params.set(
          "worktree",
          normalizeStoredPath(discoverCheckout(cli.worktree, true)!.worktreePath),
        );
      if (!cli.task && !cli.worktree)
        params.set(
          "session",
          currentContext(process.cwd(), cli.session).session!.externalSessionId,
        );
      const result = await client().request<ShowTask[]>(`/api/show?${params}`);
      console.log(cli.json ? JSON.stringify(result, null, 2) : renderShow(result));
      break;
    }
    case "sync":
      // TODO: Remove this compatibility alias after callers migrate to `wr pr sync`.
      console.log(`synced prs=${await syncPullRequestStates(false)}`);
      break;
    case "doctor":
      await runDoctor();
      break;
    case "ui": {
      const targets = await client().request<FocusTarget[]>("/api/focus-targets");
      await render(createElement(WrUi, { targets })).waitUntilExit();
      break;
    }
    case "legacy-tasks":
      await runResource("tasks", cli);
      break;
    case "legacy-sessions":
      await runResource("sessions", cli);
      break;
    case "legacy-checkouts":
      await runResource("checkouts", cli);
      break;
    case "legacy-executions":
      await runResource("executions", cli);
      break;
    case "legacy-links":
      await runResource("links", cli);
      break;
    case "legacy-prs":
      await runResource("prs", cli);
      break;
    case "legacy-branches":
      await runResource("branches", cli);
      break;
    case "legacy-repos":
      await runResource("repos", cli);
      break;
    case "legacy-runs":
      await runResource("runs", cli);
      break;
    case "legacy-runs-focus":
      await focusTerminal(cli.target, true);
      break;
    case "legacy-terminals":
      await runResource("terminals", cli);
      break;
    case "legacy-terminals-focus":
      await focusTerminal(cli.target, false);
      break;
  }
} catch (error) {
  console.error(`wr: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
