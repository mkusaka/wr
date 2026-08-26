import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename } from "node:path";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import * as v from "valibot";
import type { ContextInput, SessionIdentity } from "./api.ts";
import { discoverCheckout, type Checkout } from "./git.ts";
import {
  HookPayloadSchema,
  SessionIdentitySchema,
  ToolHookPayloadSchema,
  type HookPayload,
  type ToolHookPayload,
} from "./validation.ts";

export type Cli = "codex" | "claude" | "devin" | "pi";

export function normalizeStoredPath(path: string, home = process.env.HOME): string {
  if (!home) return path;
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

export function normalizeStoredCheckout(checkout: Checkout | null): Checkout | null {
  return checkout
    ? {
        ...checkout,
        repoRoot: normalizeStoredPath(checkout.repoRoot),
        worktreePath: normalizeStoredPath(checkout.worktreePath),
      }
    : null;
}

type DevinSessionState = {
  cli: "devin";
  externalSessionId: string;
  runId: string | null;
  projectDir: string | null;
  devinPid: number | null;
};

function parseSessionIdentity(value: string): SessionIdentity {
  const colon = value.indexOf(":");
  try {
    return v.parse(SessionIdentitySchema, {
      cli: value.slice(0, colon),
      externalSessionId: value.slice(colon + 1),
    });
  } catch {
    throw new Error(`Invalid session: ${value}`);
  }
}

function devinSessionPath(): string {
  return join(
    process.env.XDG_STATE_HOME ?? join(process.env.HOME ?? process.cwd(), ".local", "state"),
    "wr",
    "devin-sessions.json",
  );
}

function readDevinSessions(): DevinSessionState[] {
  try {
    const path = devinSessionPath();
    if (!existsSync(path)) return [];
    const data = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!Array.isArray(data)) return [];
    return data.filter(
      (item): item is DevinSessionState =>
        typeof item === "object" &&
        item !== null &&
        item.cli === "devin" &&
        typeof item.externalSessionId === "string" &&
        item.externalSessionId.length > 0,
    );
  } catch {
    return [];
  }
}

function writeDevinSessions(sessions: DevinSessionState[]): void {
  try {
    const path = devinSessionPath();
    mkdirSync(dirname(path), { recursive: true });
    if (sessions.length === 0) {
      rmSync(path, { force: true });
    } else {
      writeFileSync(path, JSON.stringify(sessions));
    }
  } catch {}
}

function getProcessInfo(pid: number): { pid: number; ppid: number; command: string } | null {
  try {
    const result = Bun.spawnSync(["ps", "-p", String(pid), "-o", "ppid=,command="]);
    const output = result.stdout.toString().trim();
    const match = output.match(/^(\d+)\s+(.+)$/);
    if (!match || !match[1] || !match[2]) return null;
    return { pid, ppid: Number(match[1]), command: match[2] };
  } catch {
    return null;
  }
}

function isDevinCommand(command: string): boolean {
  const first = command.trim().split(/\s+/)[0] ?? "";
  return basename(first).toLowerCase() === "devin";
}

export function findDevinProcessPid(startPid = process.pid, maxDepth = 10): number | null {
  const override = process.env.WR_DEVIN_PROCESS_PID;
  if (override) return Number(override);
  let pid = startPid;
  for (let i = 0; i < maxDepth; i++) {
    const info = getProcessInfo(pid);
    if (!info) return null;
    if (isDevinCommand(info.command)) return pid;
    if (info.ppid <= 1 || info.ppid === pid) return null;
    pid = info.ppid;
  }
  return null;
}

function devinDbPath(): string | null {
  return (
    process.env.CHISEL_SESSION_DB ??
    (process.env.HOME
      ? join(process.env.HOME, ".local", "share", "devin", "cli", "sessions.db")
      : null)
  );
}

function findDevinSessionFromDb(projectDir?: string, cwd?: string): SessionIdentity | null {
  const dbPath = devinDbPath();
  if (!dbPath || !existsSync(dbPath)) return null;
  const dir = projectDir ?? cwd;
  if (!dir) return null;
  try {
    const db = new Database(dbPath, { readonly: true });
    const query = db.query<{ id: string; working_directory: string }, [string, string]>(
      `SELECT id, working_directory FROM sessions
       WHERE hidden = 0
         AND (working_directory = ?1 OR ?2 LIKE working_directory || '/%')
       ORDER BY last_activity_at DESC, length(working_directory) DESC
       LIMIT 1`,
    );
    const row = query.get(dir, dir);
    query.finalize();
    db.close();
    if (!row) return null;
    return { cli: "devin", externalSessionId: row.id };
  } catch {
    return null;
  }
}

function findDevinSessionByPid(devinPid?: number | null): DevinSessionState | null {
  if (!devinPid) return null;
  const sessions = readDevinSessions();
  return sessions.find((s) => s.devinPid === devinPid) ?? null;
}

function applyDevinSession(
  data: Pick<DevinSessionState, "externalSessionId" | "runId">,
): SessionIdentity {
  if (data.runId) process.env.WR_SESSION_RUN_ID = data.runId;
  return { cli: "devin", externalSessionId: data.externalSessionId };
}

export function writeDevinSession(
  identity: SessionIdentity,
  runId: string | null,
  projectDir: string | null,
  devinPid: number | null,
): void {
  if (identity.cli !== "devin" || devinPid == null) return;
  const sessions = readDevinSessions();
  const withoutThis = sessions.filter(
    (s) => s.externalSessionId !== identity.externalSessionId && s.devinPid !== devinPid,
  );
  withoutThis.push({
    cli: "devin",
    externalSessionId: identity.externalSessionId,
    runId,
    projectDir,
    devinPid,
  });
  writeDevinSessions(withoutThis);
}

export function clearDevinSession(externalSessionId?: string, devinPid?: number | null): void {
  const sessions = readDevinSessions();
  const remaining = sessions.filter((s) => {
    if (externalSessionId && s.externalSessionId === externalSessionId) return false;
    if (devinPid && s.devinPid === devinPid) return false;
    return true;
  });
  writeDevinSessions(remaining);
}

function resolveDevinSession(env: NodeJS.ProcessEnv, cwd?: string): SessionIdentity | null {
  const devinPid = env === process.env ? findDevinProcessPid() : null;
  const state = findDevinSessionByPid(devinPid);
  if (state) return applyDevinSession(state);
  const dir = env.DEVIN_PROJECT_DIR ?? cwd;
  return findDevinSessionFromDb(dir, dir);
}

export function findCurrentSession(
  explicitSession?: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd?: string,
): SessionIdentity | null {
  if (explicitSession) {
    if (explicitSession.includes(":")) return parseSessionIdentity(explicitSession);
    if (env === process.env) {
      const data = resolveDevinSession(env, cwd);
      if (data?.externalSessionId === explicitSession) return data;
    }
    return parseSessionIdentity(`${inferCli(env, explicitSession, cwd)}:${explicitSession}`);
  }
  if (env.PI_SESSION_ID) return { cli: "pi", externalSessionId: env.PI_SESSION_ID };
  if (env.CODEX_THREAD_ID) return { cli: "codex", externalSessionId: env.CODEX_THREAD_ID };
  if (env.CLAUDE_CODE_SESSION_ID)
    return { cli: "claude", externalSessionId: env.CLAUDE_CODE_SESSION_ID };
  if (env.DEVIN_SESSION_ID) return { cli: "devin", externalSessionId: env.DEVIN_SESSION_ID };
  if (env.WR_CLI_SESSION) return parseSessionIdentity(env.WR_CLI_SESSION);
  if (env === process.env) {
    const data = resolveDevinSession(env, cwd);
    if (data) return data;
  }
  return null;
}

function inferCli(env: NodeJS.ProcessEnv, explicitSession?: string, cwd?: string): Cli {
  if (env.PI_SESSION_ID) return "pi";
  if (env.CODEX_THREAD_ID) return "codex";
  if (env.CLAUDE_CODE_SESSION_ID) return "claude";
  if (env.DEVIN_SESSION_ID) return "devin";
  if (env === process.env && explicitSession) {
    const data = resolveDevinSession(env, cwd);
    if (data?.externalSessionId === explicitSession) return "devin";
  }
  throw new Error("A CLI prefix is required for --session outside Pi, Codex, Claude, or Devin");
}

export function currentContext(cwd: string, explicitSession?: string): ContextInput {
  const session = findCurrentSession(explicitSession, process.env, cwd);
  if (!session) throw new Error("Could not resolve a session; pass an existing --session ID");
  return {
    session,
    runId: process.env.WR_SESSION_RUN_ID,
    checkout: normalizeStoredCheckout(discoverCheckout(cwd)),
    terminalId: process.env.TERM_SESSION_ID,
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function appendClaudeEnvironment(
  envFile: string | undefined,
  identity: SessionIdentity,
  runId: string | null,
): void {
  if (!envFile || !runId) return;
  appendFileSync(
    envFile,
    `export WR_CLI_SESSION=${shellQuote(`${identity.cli}:${identity.externalSessionId}`)}\nexport WR_SESSION_RUN_ID=${shellQuote(runId)}\n`,
  );
}

export function parseHookPayload(text: string, defaultCwd?: string): HookPayload {
  try {
    const value: unknown = JSON.parse(text);
    if (
      defaultCwd &&
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      !("cwd" in value)
    ) {
      return v.parse(HookPayloadSchema, { ...value, cwd: defaultCwd });
    }
    return v.parse(HookPayloadSchema, value);
  } catch {
    throw new Error("Invalid hook payload");
  }
}

export function parseToolHookPayload(text: string, defaultCwd?: string): ToolHookPayload {
  try {
    const value: unknown = JSON.parse(text);
    if (
      defaultCwd &&
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      !("cwd" in value)
    ) {
      return v.parse(ToolHookPayloadSchema, { ...value, cwd: defaultCwd });
    }
    return v.parse(ToolHookPayloadSchema, value);
  } catch {
    throw new Error("Invalid hook payload");
  }
}
