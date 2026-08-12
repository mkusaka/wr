import type { Database } from "bun:sqlite";
import { appendFileSync, realpathSync } from "node:fs";
import * as v from "valibot";
import { discoverCheckout, type Checkout } from "./git.ts";
import { newId } from "./db.ts";
import {
  CliSchema,
  HookPayloadSchema,
  IdRowSchema,
  NonEmptyStringSchema,
  SessionIdentitySchema,
  type HookPayload,
  type SessionIdentity,
} from "./validation.ts";

const DbSessionIdentitySchema = v.object({
  cli: CliSchema,
  external_session_id: NonEmptyStringSchema,
});

export type Cli = "codex" | "claude";

export type CurrentContext = SessionIdentity & {
  cliSessionId: string;
  sessionRunId: string;
  checkoutId: string | null;
  checkout: Checkout | null;
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

export function findCurrentSession(
  db: Database,
  env: NodeJS.ProcessEnv = process.env,
): SessionIdentity | null {
  if (env.CODEX_THREAD_ID) {
    return v.parse(SessionIdentitySchema, {
      cli: "codex",
      externalSessionId: env.CODEX_THREAD_ID,
    });
  }
  if (env.CLAUDE_CODE_SESSION_ID) {
    return v.parse(SessionIdentitySchema, {
      cli: "claude",
      externalSessionId: env.CLAUDE_CODE_SESSION_ID,
    });
  }
  if (env.WR_CLI_SESSION) return parseSessionIdentity(env.WR_CLI_SESSION);
  if (!env.TERM_SESSION_ID) return null;
  const row = v.parse(
    v.nullable(DbSessionIdentitySchema),
    db
      .query(
        `SELECT cs.cli, cs.external_session_id
           FROM session_runs sr
           JOIN cli_sessions cs ON cs.id = sr.cli_session_id
          WHERE sr.iterm_session_id = $terminalId AND sr.ended_at IS NULL
          ORDER BY sr.last_seen_at DESC LIMIT 1`,
      )
      .get({ terminalId: env.TERM_SESSION_ID }),
  );
  return row ? { cli: row.cli, externalSessionId: row.external_session_id } : null;
}

function ensureCliSession(db: Database, identity: SessionIdentity): string {
  const existing = v.parse(
    v.nullable(IdRowSchema),
    db
      .query(
        "SELECT id FROM cli_sessions WHERE cli = $cli AND external_session_id = $externalSessionId",
      )
      .get(identity),
  );
  if (existing) return existing.id;
  const id = newId();
  db.query(
    "INSERT INTO cli_sessions (id, cli, external_session_id) VALUES ($id, $cli, $externalSessionId)",
  ).run({
    id,
    ...identity,
  });
  return id;
}

export function ensureCheckout(db: Database, checkout: Checkout | null): string | null {
  if (!checkout) return null;
  const existing = v.parse(
    v.nullable(IdRowSchema),
    db
      .query(
        "SELECT id FROM git_checkouts WHERE repo_root = $repoRoot AND worktree_path = $worktreePath",
      )
      .get(checkout),
  );
  if (existing) {
    db.query("UPDATE git_checkouts SET branch = $branch WHERE id = $id").run({
      id: existing.id,
      branch: checkout.branch,
    });
    return existing.id;
  }
  const id = newId();
  db.query(
    "INSERT INTO git_checkouts (id, repo_root, worktree_path, branch) VALUES ($id, $repoRoot, $worktreePath, $branch)",
  ).run({ id, ...checkout });
  return id;
}

export function touchRunCheckout(
  db: Database,
  sessionRunId: string,
  checkoutId: string | null,
): void {
  if (!checkoutId) return;
  db.query(
    `INSERT INTO session_run_checkouts (session_run_id, checkout_id)
     VALUES ($sessionRunId, $checkoutId)
     ON CONFLICT(session_run_id, checkout_id) DO UPDATE SET
       last_seen_at = CURRENT_TIMESTAMP`,
  ).run({ sessionRunId, checkoutId });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function appendClaudeEnvironment(
  envFile: string | undefined,
  identity: SessionIdentity,
  runId: string,
): void {
  if (!envFile) return;
  appendFileSync(
    envFile,
    `export WR_CLI_SESSION=${shellQuote(`${identity.cli}:${identity.externalSessionId}`)}\nexport WR_SESSION_RUN_ID=${shellQuote(runId)}\n`,
  );
}

export function registerSessionEvent(
  db: Database,
  cli: Cli,
  payload: HookPayload,
  env: NodeJS.ProcessEnv = process.env,
): { cliSessionId: string; sessionRunId: string | null } {
  const identity = { cli, externalSessionId: payload.session_id };
  const terminalId = env.TERM_SESSION_ID || null;
  const source = payload.source || "unknown";
  const cwd = realpathSync(payload.cwd);

  if (source === "compact") {
    const session = v.parse(
      v.nullable(IdRowSchema),
      db
        .query(
          "SELECT id FROM cli_sessions WHERE cli = $cli AND external_session_id = $externalSessionId",
        )
        .get(identity),
    );
    if (!session) return { cliSessionId: "", sessionRunId: null };
    const run = v.parse(
      v.nullable(IdRowSchema),
      db
        .query(
          terminalId
            ? "SELECT id FROM session_runs WHERE cli_session_id = $sessionId AND iterm_session_id = $terminalId AND ended_at IS NULL ORDER BY last_seen_at DESC LIMIT 1"
            : "SELECT id FROM session_runs WHERE cli_session_id = $sessionId AND ended_at IS NULL ORDER BY last_seen_at DESC LIMIT 1",
        )
        .get({ sessionId: session.id, terminalId }),
    );
    if (run) {
      db.transaction(() => {
        db.query("UPDATE session_runs SET last_seen_at = CURRENT_TIMESTAMP WHERE id = $id").run(
          run,
        );
        touchRunCheckout(db, run.id, ensureCheckout(db, discoverCheckout(cwd)));
      }).immediate();
      if (cli === "claude") appendClaudeEnvironment(env.CLAUDE_ENV_FILE, identity, run.id);
    }
    return { cliSessionId: session.id, sessionRunId: run?.id ?? null };
  }

  const checkout = discoverCheckout(cwd);
  let cliSessionId = "";
  let sessionRunId = "";
  db.transaction(() => {
    cliSessionId = ensureCliSession(db, identity);
    if (terminalId) {
      db.query(
        `UPDATE session_runs
            SET ended_at = CURRENT_TIMESTAMP, end_reason = 'superseded'
          WHERE iterm_session_id = $terminalId AND ended_at IS NULL`,
      ).run({ terminalId });
    }
    const checkoutId = ensureCheckout(db, checkout);
    sessionRunId = newId();
    db.query(
      `INSERT INTO session_runs
        (id, cli_session_id, iterm_session_id, started_cwd, source)
       VALUES ($id, $cliSessionId, $terminalId, $cwd, $source)`,
    ).run({ id: sessionRunId, cliSessionId, terminalId, cwd, source });
    touchRunCheckout(db, sessionRunId, checkoutId);
  }).immediate();

  if (cli === "claude") appendClaudeEnvironment(env.CLAUDE_ENV_FILE, identity, sessionRunId);
  return { cliSessionId, sessionRunId };
}

export function endSession(
  db: Database,
  cli: Cli,
  payload: HookPayload,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const session = v.parse(
    v.nullable(IdRowSchema),
    db
      .query(
        "SELECT id FROM cli_sessions WHERE cli = $cli AND external_session_id = $externalSessionId",
      )
      .get({ cli, externalSessionId: payload.session_id }),
  );
  if (!session) return null;
  const terminalId = env.TERM_SESSION_ID || null;
  const run = v.parse(
    v.nullable(IdRowSchema),
    db
      .query(
        terminalId
          ? "SELECT id FROM session_runs WHERE cli_session_id = $sessionId AND iterm_session_id = $terminalId AND ended_at IS NULL ORDER BY last_seen_at DESC LIMIT 1"
          : "SELECT id FROM session_runs WHERE cli_session_id = $sessionId AND ended_at IS NULL ORDER BY last_seen_at DESC LIMIT 1",
      )
      .get({ sessionId: session.id, terminalId }),
  );
  if (!run) return null;
  db.query(
    "UPDATE session_runs SET ended_at = CURRENT_TIMESTAMP, end_reason = 'session_end', last_seen_at = CURRENT_TIMESTAMP WHERE id = $id",
  ).run(run);
  return run.id;
}

export function resolveCurrentContext(
  db: Database,
  cwd: string,
  explicitSession?: string,
  env: NodeJS.ProcessEnv = process.env,
): CurrentContext {
  const automatic = findCurrentSession(db, env);
  let requestedRunId: string | null = null;
  if (automatic && env.WR_CLI_SESSION === `${automatic.cli}:${automatic.externalSessionId}`) {
    requestedRunId = env.WR_SESSION_RUN_ID || null;
  }

  if (automatic && explicitSession && automatic.externalSessionId !== explicitSession) {
    throw new Error("The discovered session conflicts with --session");
  }
  let identity = automatic;
  if (!identity && explicitSession) {
    const rows = v.parse(
      v.array(DbSessionIdentitySchema),
      db
        .query("SELECT cli, external_session_id FROM cli_sessions WHERE external_session_id = $id")
        .all({ id: explicitSession }),
    );
    if (rows.length > 1) throw new Error(`Session ID is ambiguous: ${explicitSession}`);
    if (rows.length === 1)
      identity = { cli: rows[0]!.cli, externalSessionId: rows[0]!.external_session_id };
  }
  if (!identity) throw new Error("Could not resolve a session; pass an existing --session ID");

  let cliSessionId = "";
  let sessionRunId = "";
  const checkout = discoverCheckout(cwd);
  let checkoutId: string | null = null;
  db.transaction(() => {
    cliSessionId = ensureCliSession(db, identity);
    const params = {
      runId: requestedRunId,
      sessionId: cliSessionId,
      terminalId: env.TERM_SESSION_ID || null,
    };
    let run = requestedRunId
      ? v.parse(
          v.nullable(IdRowSchema),
          db
            .query(
              "SELECT id FROM session_runs WHERE id = $runId AND cli_session_id = $sessionId AND ended_at IS NULL",
            )
            .get(params),
        )
      : null;
    if (!run) {
      run = v.parse(
        v.nullable(IdRowSchema),
        db
          .query(
            params.terminalId
              ? "SELECT id FROM session_runs WHERE cli_session_id = $sessionId AND iterm_session_id = $terminalId AND ended_at IS NULL ORDER BY last_seen_at DESC LIMIT 1"
              : "SELECT id FROM session_runs WHERE cli_session_id = $sessionId AND ended_at IS NULL ORDER BY last_seen_at DESC LIMIT 1",
          )
          .get(params),
      );
    }
    if (run) {
      sessionRunId = run.id;
      db.query("UPDATE session_runs SET last_seen_at = CURRENT_TIMESTAMP WHERE id = $id").run(run);
    } else {
      if (params.terminalId) {
        db.query(
          "UPDATE session_runs SET ended_at = CURRENT_TIMESTAMP, end_reason = 'superseded' WHERE iterm_session_id = $terminalId AND ended_at IS NULL",
        ).run(params);
      }
      sessionRunId = newId();
      db.query(
        `INSERT INTO session_runs (id, cli_session_id, iterm_session_id, started_cwd, source)
         VALUES ($id, $sessionId, $terminalId, $cwd, 'unknown')`,
      ).run({
        id: sessionRunId,
        sessionId: cliSessionId,
        terminalId: params.terminalId,
        cwd: realpathSync(cwd),
      });
    }
    checkoutId = ensureCheckout(db, checkout);
    touchRunCheckout(db, sessionRunId, checkoutId);
  }).immediate();

  return { ...identity, cliSessionId, sessionRunId, checkoutId, checkout };
}

export function parseHookPayload(text: string): HookPayload {
  try {
    return v.parse(HookPayloadSchema, JSON.parse(text));
  } catch {
    throw new Error("Hook payload is invalid");
  }
}
