import { appendFileSync } from "node:fs";
import * as v from "valibot";
import type { ContextInput, SessionIdentity } from "./api.ts";
import { discoverCheckout, type Checkout } from "./git.ts";
import { HookPayloadSchema, SessionIdentitySchema, type HookPayload } from "./validation.ts";

export type Cli = "codex" | "claude" | "devin";

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

export function findCurrentSession(
  explicitSession?: string,
  env: NodeJS.ProcessEnv = process.env,
): SessionIdentity | null {
  if (explicitSession)
    return parseSessionIdentity(
      explicitSession.includes(":") ? explicitSession : `${inferCli(env)}:${explicitSession}`,
    );
  if (env.CODEX_THREAD_ID) return { cli: "codex", externalSessionId: env.CODEX_THREAD_ID };
  if (env.CLAUDE_CODE_SESSION_ID)
    return { cli: "claude", externalSessionId: env.CLAUDE_CODE_SESSION_ID };
  if (env.DEVIN_SESSION_ID) return { cli: "devin", externalSessionId: env.DEVIN_SESSION_ID };
  if (env.WR_CLI_SESSION) return parseSessionIdentity(env.WR_CLI_SESSION);
  return null;
}

function inferCli(env: NodeJS.ProcessEnv): Cli {
  if (env.CODEX_THREAD_ID) return "codex";
  if (env.CLAUDE_CODE_SESSION_ID) return "claude";
  if (env.DEVIN_SESSION_ID) return "devin";
  throw new Error("A CLI prefix is required for --session outside Codex, Claude, or Devin");
}

export function currentContext(cwd: string, explicitSession?: string): ContextInput {
  const session = findCurrentSession(explicitSession);
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
