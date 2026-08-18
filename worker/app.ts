import { and, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { alias, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { inertia } from "@hono/inertia";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import * as v from "valibot";
import {
  CheckoutInputSchema,
  ContextInputSchema,
  ConversationLinkInputSchema,
  PullRequestInputSchema,
  type CheckoutInput,
  type ContextInput,
} from "../src/api.ts";
import {
  CliSchema,
  HookPayloadSchema,
  NonEmptyStringSchema,
  slackConversationKey,
  TaskStatusSchema,
} from "../src/validation.ts";
import { authenticateAccess, type Env, type Principal } from "./auth.ts";
import * as schema from "./schema.ts";
import { rootView } from "./root-view.tsx";

type Database = DrizzleD1Database<typeof schema>;
type Variables = { principal: Principal; userId: string; deviceId?: string };
type Authenticator = (request: Request, env: Env) => Promise<Principal>;

const jsonObject = v.record(v.string(), v.unknown());
const now = sql`CURRENT_TIMESTAMP`;

function id(): string {
  return crypto.randomUUID();
}

async function ensureUser(db: Database, principal: Principal) {
  await db
    .insert(schema.users)
    .values({ id: id(), accessSubject: principal.subject, email: principal.email })
    .onConflictDoUpdate({
      target: schema.users.accessSubject,
      set: { email: principal.email, lastSeenAt: now },
    });
  const user = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.accessSubject, principal.subject))
    .get();
  return user!.id;
}

async function ensureDevice(db: Database, userId: string, deviceId: string, name: string) {
  const existing = await db
    .select({ userId: schema.devices.userId })
    .from(schema.devices)
    .where(eq(schema.devices.id, deviceId))
    .get();
  if (existing && existing.userId !== userId)
    throw new HTTPException(403, { message: "Device belongs to another user" });
  await db
    .insert(schema.devices)
    .values({
      id: deviceId,
      userId,
      name,
    })
    .onConflictDoUpdate({
      target: schema.devices.id,
      set: { name, lastSeenAt: now },
    });
  return deviceId;
}

function deviceScope(column: AnySQLiteColumn, userId: string): SQL {
  return sql`${column} IN (SELECT ${schema.devices.id} FROM ${schema.devices} WHERE ${schema.devices.userId} = ${userId})`;
}

function visibleDeviceIds(userId: string, deviceId: string | undefined, all: boolean): SQL {
  return all || !deviceId
    ? sql`SELECT ${schema.devices.id} FROM ${schema.devices} WHERE ${schema.devices.userId} = ${userId}`
    : sql`SELECT ${schema.devices.id} FROM ${schema.devices} WHERE ${schema.devices.userId} = ${userId} AND ${schema.devices.id} = ${deviceId}`;
}

function scopedDevice(
  column: AnySQLiteColumn,
  userId: string,
  deviceId: string | undefined,
  all: boolean,
): SQL {
  return all || !deviceId ? deviceScope(column, userId) : eq(column, deviceId);
}

function taskScope(userId: string, deviceId: string | undefined, all: boolean): SQL {
  const devices = visibleDeviceIds(userId, deviceId, all);
  return sql`(
    ${schema.tasks.createdByDeviceId} IN (${devices})
    OR EXISTS (
      SELECT 1 FROM executions e
      WHERE e.task_id = ${schema.tasks.id}
        AND e.device_id IN (${devices})
    )
    OR EXISTS (
      SELECT 1 FROM workpad_links w
      WHERE w.task_id = ${schema.tasks.id}
        AND w.device_id IN (${devices})
    )
  )`;
}

function pullRequestScope(userId: string, deviceId: string | undefined, all: boolean): SQL {
  const devices = visibleDeviceIds(userId, deviceId, all);
  return sql`(
    ${schema.pullRequests.createdByDeviceId} IN (${devices})
    OR EXISTS (
      SELECT 1 FROM session_run_pull_requests srp
      WHERE srp.pull_request_id = ${schema.pullRequests.id}
        AND srp.device_id IN (${devices})
    )
  )`;
}

async function ensureTask(db: Database, deviceId: string, issue: string) {
  const existing = await db
    .select({ id: schema.tasks.id })
    .from(schema.tasks)
    .where(eq(schema.tasks.issueId, issue))
    .get();
  if (existing) return existing;
  const task = { id: id() };
  await db.insert(schema.tasks).values({
    ...task,
    issueId: issue,
    createdByDeviceId: deviceId,
  });
  return task;
}

async function ensureSession(db: Database, deviceId: string, session: ContextInput["session"]) {
  if (!session) throw new HTTPException(400, { message: "Could not resolve a session" });
  const existing = await db
    .select({ id: schema.cliSessions.id })
    .from(schema.cliSessions)
    .where(
      and(
        eq(schema.cliSessions.deviceId, deviceId),
        eq(schema.cliSessions.cli, session.cli),
        eq(schema.cliSessions.externalSessionId, session.externalSessionId),
      ),
    )
    .get();
  if (existing) return existing.id;
  const sessionId = id();
  await db.insert(schema.cliSessions).values({
    id: sessionId,
    deviceId,
    cli: session.cli,
    externalSessionId: session.externalSessionId,
    updatedAt: now,
  });
  return sessionId;
}

async function ensureCheckout(db: Database, deviceId: string, checkout: CheckoutInput | null) {
  if (!checkout) return null;
  await db
    .insert(schema.checkouts)
    .values({ id: id(), deviceId, ...checkout })
    .onConflictDoUpdate({
      target: [schema.checkouts.deviceId, schema.checkouts.repoRoot, schema.checkouts.worktreePath],
      set: { branch: checkout.branch },
    });
  const stored = await db
    .select({ id: schema.checkouts.id })
    .from(schema.checkouts)
    .where(
      and(
        eq(schema.checkouts.deviceId, deviceId),
        eq(schema.checkouts.repoRoot, checkout.repoRoot),
        eq(schema.checkouts.worktreePath, checkout.worktreePath),
      ),
    )
    .get();
  return stored!.id;
}

async function resolveContext(db: Database, deviceId: string, context: ContextInput) {
  const sessionId = await ensureSession(db, deviceId, context.session);
  let run = context.runId
    ? await db
        .select({ id: schema.sessionRuns.id })
        .from(schema.sessionRuns)
        .where(
          and(
            eq(schema.sessionRuns.deviceId, deviceId),
            eq(schema.sessionRuns.id, context.runId),
            eq(schema.sessionRuns.cliSessionId, sessionId),
            isNull(schema.sessionRuns.endedAt),
          ),
        )
        .get()
    : undefined;
  if (!run) {
    run = await db
      .select({ id: schema.sessionRuns.id })
      .from(schema.sessionRuns)
      .where(
        and(
          eq(schema.sessionRuns.deviceId, deviceId),
          eq(schema.sessionRuns.cliSessionId, sessionId),
          isNull(schema.sessionRuns.endedAt),
          context.terminalId ? eq(schema.sessionRuns.terminalId, context.terminalId) : undefined,
        ),
      )
      .orderBy(desc(schema.sessionRuns.lastSeenAt))
      .get();
  }
  if (!run) {
    const runId = id();
    await db.insert(schema.sessionRuns).values({
      id: runId,
      deviceId,
      cliSessionId: sessionId,
      terminalId: context.terminalId,
      startedCwd: context.checkout?.worktreePath ?? null,
      source: "implicit",
    });
    run = { id: runId };
  }
  const checkoutId = await ensureCheckout(db, deviceId, context.checkout);
  if (checkoutId) {
    await db
      .insert(schema.sessionRunCheckouts)
      .values({ deviceId, sessionRunId: run.id, checkoutId })
      .onConflictDoUpdate({
        target: [
          schema.sessionRunCheckouts.deviceId,
          schema.sessionRunCheckouts.sessionRunId,
          schema.sessionRunCheckouts.checkoutId,
        ],
        set: { lastSeenAt: now },
      });
  }
  return { sessionId, runId: run.id, checkoutId };
}

async function requestBody(c: { req: { json: () => Promise<unknown> } }) {
  return v.parse(jsonObject, await c.req.json());
}

function requireDevice(deviceId: string | undefined): string {
  if (!deviceId) throw new HTTPException(403, { message: "A device identity is required" });
  return deviceId;
}

function decodeLocations<T extends { repoRoots: string; worktreePaths: string }>(rows: T[]) {
  return rows.map(({ repoRoots, worktreePaths, ...row }) => ({
    ...row,
    repoRoots: JSON.parse(repoRoots),
    worktreePaths: JSON.parse(worktreePaths),
  }));
}

export function createApp(authenticate: Authenticator = authenticateAccess) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();

  app.onError((error, c) => {
    if (v.isValiError(error)) return c.json({ error: "Invalid request" }, 400);
    if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
    console.error(error);
    return c.json({ error: "Internal server error" }, 500);
  });

  app.use("*", async (c, next) => {
    const url = new URL(c.req.url);
    if (!url.pathname.startsWith("/api/") && url.pathname !== "/") return next();
    let principal: Principal;
    const hostname = url.hostname;
    if (c.env.LOCAL_DEV === "true" && ["localhost", "127.0.0.1", "[::1]"].includes(hostname)) {
      principal = { subject: "local-preview", email: "local-preview@example.test" };
    } else {
      try {
        principal = await authenticate(c.req.raw, c.env);
      } catch {
        throw new HTTPException(401, { message: "Cloudflare Access authentication failed" });
      }
    }
    c.set("principal", principal);
    const db = drizzle(c.env.DB, { schema });
    const userId = await ensureUser(db, principal);
    c.set("userId", userId);
    const deviceId = c.req.header("X-Wr-Device-Id");
    if (deviceId) {
      c.set(
        "deviceId",
        await ensureDevice(db, userId, deviceId, c.req.header("X-Wr-Device-Name") || deviceId),
      );
    }
    await next();
  });

  app.use("*", inertia({ rootView }));

  app.get("/api/health", (c) => c.json({ ok: true, principal: "user" }));

  app.get("/api/select-options/devices", async (c) => {
    const db = drizzle(c.env.DB, { schema });
    const userId = c.get("userId");
    const query = c.req.query("q")?.trim() ?? "";
    return c.json(
      await db
        .select({ id: schema.devices.id, name: schema.devices.name })
        .from(schema.devices)
        .where(
          and(
            deviceScope(schema.devices.id, userId),
            query
              ? sql`(instr(lower(${schema.devices.id}), lower(${query})) > 0 or instr(lower(${schema.devices.name}), lower(${query})) > 0)`
              : undefined,
          ),
        )
        .orderBy(desc(schema.devices.lastSeenAt))
        .limit(50),
    );
  });

  app.get("/api/select-options/repositories", async (c) => {
    const db = drizzle(c.env.DB, { schema });
    const userId = c.get("userId");
    const query = c.req.query("q")?.trim() ?? "";
    return c.json(
      await db
        .select({ repoRoot: schema.checkouts.repoRoot })
        .from(schema.checkouts)
        .where(
          and(
            deviceScope(schema.checkouts.deviceId, userId),
            query
              ? sql`instr(lower(${schema.checkouts.repoRoot}), lower(${query})) > 0`
              : undefined,
          ),
        )
        .groupBy(schema.checkouts.repoRoot)
        .orderBy(desc(sql`max(${schema.checkouts.createdAt})`))
        .limit(50),
    );
  });

  app.get("/api/select-options/worktrees", async (c) => {
    const db = drizzle(c.env.DB, { schema });
    const userId = c.get("userId");
    const query = c.req.query("q")?.trim() ?? "";
    return c.json(
      await db
        .selectDistinct({ worktreePath: schema.checkouts.worktreePath })
        .from(schema.checkouts)
        .where(
          and(
            deviceScope(schema.checkouts.deviceId, userId),
            query
              ? sql`instr(lower(${schema.checkouts.worktreePath}), lower(${query})) > 0`
              : undefined,
          ),
        )
        .orderBy(schema.checkouts.worktreePath)
        .limit(50),
    );
  });

  app.get("/api/tasks", async (c) => {
    const db = drizzle(c.env.DB, { schema });
    const userId = c.get("userId");
    const deviceId = c.get("deviceId");
    const all = c.req.query("all") === "true" || c.req.query("global") === "true";
    const devices = visibleDeviceIds(userId, deviceId, all);
    const status = v.parse(v.optional(TaskStatusSchema), c.req.query("status"));
    return c.json(
      decodeLocations(
        await db
          .select({
            linearIssueId: schema.tasks.issueId,
            title: schema.tasks.title,
            status: schema.tasks.status,
            createdAt: schema.tasks.createdAt,
            updatedAt: schema.tasks.updatedAt,
            repoRoots: sql<string>`coalesce((select json_group_array(repo_root) from (
            select distinct c.repo_root as repo_root
            from executions e join checkouts c on c.id = e.checkout_id
            where e.task_id = ${sql.raw('"tasks"."id"')}
              and e.device_id in (${devices})
            union
            select distinct c.repo_root as repo_root
            from workpad_links w join checkouts c on c.id = w.checkout_id
            where w.task_id = ${sql.raw('"tasks"."id"')}
              and w.device_id in (${devices})
          )), '[]')`,
            worktreePaths: sql<string>`coalesce((select json_group_array(worktree_path) from (
            select distinct c.worktree_path as worktree_path
            from executions e join checkouts c on c.id = e.checkout_id
            where e.task_id = ${sql.raw('"tasks"."id"')}
              and e.device_id in (${devices})
            union
            select distinct c.worktree_path as worktree_path
            from workpad_links w join checkouts c on c.id = w.checkout_id
            where w.task_id = ${sql.raw('"tasks"."id"')}
              and w.device_id in (${devices})
          )), '[]')`,
          })
          .from(schema.tasks)
          .where(
            and(
              taskScope(userId, deviceId, all),
              status ? eq(schema.tasks.status, status) : undefined,
            ),
          )
          .orderBy(desc(schema.tasks.updatedAt), schema.tasks.issueId),
      ),
    );
  });

  app.post("/api/tasks", async (c) => {
    const deviceId = requireDevice(c.get("deviceId"));
    const db = drizzle(c.env.DB, { schema });
    const value = await requestBody(c);
    const issue = v.parse(v.string(), value.issue);
    const title = v.parse(v.optional(v.string()), value.title);
    const existing = await db
      .select({ id: schema.tasks.id, status: schema.tasks.status })
      .from(schema.tasks)
      .where(eq(schema.tasks.issueId, issue))
      .get();
    if (existing) {
      if (title !== undefined) {
        await db
          .update(schema.tasks)
          .set({ title, updatedAt: now })
          .where(eq(schema.tasks.id, existing.id));
      }
      return c.json({ issue, status: existing.status });
    }
    await db
      .insert(schema.tasks)
      .values({ id: id(), issueId: issue, title, createdByDeviceId: deviceId });
    return c.json({ issue, status: "open" }, 201);
  });

  app.post("/api/tasks/:issue/start", async (c) => {
    const deviceId = requireDevice(c.get("deviceId"));
    const db = drizzle(c.env.DB, { schema });
    const value = await requestBody(c);
    const context = v.parse(ContextInputSchema, value.context);
    const title = v.parse(v.optional(v.string()), value.title);
    const current = await resolveContext(db, deviceId, context);
    const issue = c.req.param("issue");
    const task = await db
      .select({ id: schema.tasks.id, status: schema.tasks.status })
      .from(schema.tasks)
      .where(eq(schema.tasks.issueId, issue))
      .get();
    const taskId = task?.id ?? id();
    if (task) {
      await db
        .update(schema.tasks)
        .set({ status: "active", title: title ?? undefined, updatedAt: now })
        .where(eq(schema.tasks.id, taskId));
    } else {
      await db.insert(schema.tasks).values({
        id: taskId,
        issueId: issue,
        title,
        status: "active",
        createdByDeviceId: deviceId,
      });
    }
    const activeExecution = await db
      .select({ id: schema.executions.id })
      .from(schema.executions)
      .where(
        and(
          eq(schema.executions.deviceId, deviceId),
          eq(schema.executions.taskId, taskId),
          eq(schema.executions.cliSessionId, current.sessionId),
          current.checkoutId
            ? eq(schema.executions.checkoutId, current.checkoutId)
            : isNull(schema.executions.checkoutId),
          eq(schema.executions.status, "active"),
        ),
      )
      .get();
    const executionId = activeExecution?.id ?? id();
    if (activeExecution) {
      await db
        .update(schema.executions)
        .set({ sessionRunId: current.runId })
        .where(eq(schema.executions.id, executionId));
    } else {
      await db.insert(schema.executions).values({
        id: executionId,
        deviceId,
        taskId,
        cliSessionId: current.sessionId,
        sessionRunId: current.runId,
        checkoutId: current.checkoutId,
      });
    }
    return c.json({
      executionId,
      reopened: task?.status === "done" || task?.status === "cancelled",
    });
  });

  app.post("/api/tasks/:issue/:action", async (c) => {
    const deviceId = requireDevice(c.get("deviceId"));
    const db = drizzle(c.env.DB, { schema });
    const action = c.req.param("action");
    if (action !== "done" && action !== "cancel") throw new HTTPException(404);
    const value = await requestBody(c);
    const current = await resolveContext(db, deviceId, v.parse(ContextInputSchema, value.context));
    let task =
      c.req.param("issue") === "current"
        ? await db
            .select({ id: schema.tasks.id, issue: schema.tasks.issueId })
            .from(schema.tasks)
            .innerJoin(schema.executions, eq(schema.executions.taskId, schema.tasks.id))
            .where(
              and(
                eq(schema.executions.deviceId, deviceId),
                eq(schema.executions.checkoutId, current.checkoutId ?? ""),
                eq(schema.executions.status, "active"),
              ),
            )
            .get()
        : await db
            .select({ id: schema.tasks.id, issue: schema.tasks.issueId })
            .from(schema.tasks)
            .where(eq(schema.tasks.issueId, c.req.param("issue")))
            .get();
    if (!task && c.req.param("issue") !== "current") {
      task = {
        ...(await ensureTask(db, deviceId, c.req.param("issue"))),
        issue: c.req.param("issue"),
      };
    }
    if (!task) throw new HTTPException(404, { message: `Task not found: ${c.req.param("issue")}` });
    const ensureTaskStatement = db
      .insert(schema.tasks)
      .values({ id: task.id, issueId: task.issue, createdByDeviceId: deviceId })
      .onConflictDoNothing();
    const taskStatement = db
      .update(schema.tasks)
      .set({ status: action === "done" ? "done" : "cancelled", updatedAt: now })
      .where(eq(schema.tasks.id, task.id));
    const abandonedStatement = db
      .update(schema.executions)
      .set({ status: "abandoned", finishedAt: now })
      .where(
        and(
          eq(schema.executions.deviceId, deviceId),
          eq(schema.executions.taskId, task.id),
          eq(schema.executions.status, "active"),
        ),
      );
    if (action === "done") {
      const [, , finishedResult, abandonedResult] = await db.batch([
        ensureTaskStatement,
        taskStatement,
        db
          .update(schema.executions)
          .set({ status: "finished", finishedAt: now })
          .where(
            and(
              eq(schema.executions.deviceId, deviceId),
              eq(schema.executions.taskId, task.id),
              eq(schema.executions.cliSessionId, current.sessionId),
              eq(schema.executions.status, "active"),
            ),
          ),
        abandonedStatement,
      ]);
      return c.json({
        issue: task.issue,
        finished: finishedResult.meta.changes,
        abandoned: abandonedResult.meta.changes,
      });
    }
    const [, , abandonedResult] = await db.batch([
      ensureTaskStatement,
      taskStatement,
      abandonedStatement,
    ]);
    return c.json({ issue: task.issue, finished: 0, abandoned: abandonedResult.meta.changes });
  });

  app.post("/api/session-events", async (c) => {
    const deviceId = requireDevice(c.get("deviceId"));
    const db = drizzle(c.env.DB, { schema });
    const value = await requestBody(c);
    const cli = v.parse(CliSchema, value.cli);
    const payload = v.parse(HookPayloadSchema, value.payload);
    const terminalId = v.parse(v.optional(v.string()), value.terminalId);
    const checkout = v.parse(v.nullable(CheckoutInputSchema), value.checkout ?? null);
    await db
      .insert(schema.cliSessions)
      .values({ id: id(), deviceId, cli, externalSessionId: payload.session_id, updatedAt: now })
      .onConflictDoUpdate({
        target: [
          schema.cliSessions.deviceId,
          schema.cliSessions.cli,
          schema.cliSessions.externalSessionId,
        ],
        set: { updatedAt: now },
      });
    const session = (await db
      .select({ id: schema.cliSessions.id })
      .from(schema.cliSessions)
      .where(
        and(
          eq(schema.cliSessions.deviceId, deviceId),
          eq(schema.cliSessions.cli, cli),
          eq(schema.cliSessions.externalSessionId, payload.session_id),
        ),
      )
      .get())!;
    if (payload.source === "compact") {
      const run = await db
        .select({ id: schema.sessionRuns.id })
        .from(schema.sessionRuns)
        .where(
          and(
            eq(schema.sessionRuns.deviceId, deviceId),
            eq(schema.sessionRuns.cliSessionId, session.id),
            isNull(schema.sessionRuns.endedAt),
          ),
        )
        .orderBy(desc(schema.sessionRuns.lastSeenAt))
        .get();
      if (!run) return c.json({ sessionId: session.id, runId: null });
      await db
        .update(schema.sessionRuns)
        .set({ lastSeenAt: now })
        .where(eq(schema.sessionRuns.id, run.id));
      const checkoutId = await ensureCheckout(db, deviceId, checkout);
      if (checkoutId) {
        await db
          .insert(schema.sessionRunCheckouts)
          .values({ deviceId, sessionRunId: run.id, checkoutId })
          .onConflictDoUpdate({
            target: [
              schema.sessionRunCheckouts.deviceId,
              schema.sessionRunCheckouts.sessionRunId,
              schema.sessionRunCheckouts.checkoutId,
            ],
            set: { lastSeenAt: now },
          });
      }
      return c.json({ sessionId: session.id, runId: run.id });
    }
    if (terminalId) {
      await db
        .update(schema.sessionRuns)
        .set({ endedAt: now, endReason: "superseded" })
        .where(
          and(
            eq(schema.sessionRuns.deviceId, deviceId),
            eq(schema.sessionRuns.terminalId, terminalId),
            isNull(schema.sessionRuns.endedAt),
          ),
        );
    }
    const runId = id();
    await db.insert(schema.sessionRuns).values({
      id: runId,
      deviceId,
      cliSessionId: session.id,
      terminalId,
      startedCwd: payload.cwd,
      source: payload.source ?? "unknown",
    });
    const checkoutId = await ensureCheckout(db, deviceId, checkout);
    if (checkoutId) {
      await db
        .insert(schema.sessionRunCheckouts)
        .values({ deviceId, sessionRunId: runId, checkoutId });
    }
    return c.json({ sessionId: session.id, runId }, 201);
  });

  app.post("/api/session-prompts", async (c) => {
    const deviceId = requireDevice(c.get("deviceId"));
    const db = drizzle(c.env.DB, { schema });
    const value = await requestBody(c);
    const cli = v.parse(CliSchema, value.cli);
    const payload = v.parse(HookPayloadSchema, value.payload);
    if (!payload.prompt) return c.json({ message: "prompt is required" }, 400);
    await db
      .insert(schema.cliSessions)
      .values({
        id: id(),
        deviceId,
        cli,
        externalSessionId: payload.session_id,
        initialPrompt: payload.prompt,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          schema.cliSessions.deviceId,
          schema.cliSessions.cli,
          schema.cliSessions.externalSessionId,
        ],
        set: {
          initialPrompt: sql`coalesce(${schema.cliSessions.initialPrompt}, ${payload.prompt})`,
          updatedAt: now,
        },
      });
    return c.json({ saved: true });
  });

  app.post("/api/session-ends", async (c) => {
    const deviceId = requireDevice(c.get("deviceId"));
    const db = drizzle(c.env.DB, { schema });
    const value = await requestBody(c);
    const cli = v.parse(CliSchema, value.cli);
    const payload = v.parse(HookPayloadSchema, value.payload);
    const run = await db
      .select({ id: schema.sessionRuns.id })
      .from(schema.sessionRuns)
      .innerJoin(schema.cliSessions, eq(schema.cliSessions.id, schema.sessionRuns.cliSessionId))
      .where(
        and(
          eq(schema.sessionRuns.deviceId, deviceId),
          eq(schema.cliSessions.cli, cli),
          eq(schema.cliSessions.externalSessionId, payload.session_id),
          isNull(schema.sessionRuns.endedAt),
        ),
      )
      .orderBy(desc(schema.sessionRuns.lastSeenAt))
      .get();
    if (run) {
      await db
        .update(schema.sessionRuns)
        .set({ endedAt: now, endReason: "session_end", lastSeenAt: now })
        .where(eq(schema.sessionRuns.id, run.id));
    }
    return c.json({ runId: run?.id ?? null });
  });

  app.post("/api/runs/sync", async (c) => {
    const deviceId = requireDevice(c.get("deviceId"));
    const db = drizzle(c.env.DB, { schema });
    const value = await requestBody(c);
    const candidateRunIds = v.parse(v.array(NonEmptyStringSchema), value.candidateRunIds);
    const liveTerminalIds = new Set(v.parse(v.array(NonEmptyStringSchema), value.liveTerminalIds));
    if (candidateRunIds.length === 0) return c.json({ ended: 0 });
    const staleRunIds = (
      await db
        .select({ id: schema.sessionRuns.id, terminalId: schema.sessionRuns.terminalId })
        .from(schema.sessionRuns)
        .where(
          and(
            eq(schema.sessionRuns.deviceId, deviceId),
            isNull(schema.sessionRuns.endedAt),
            sql`${schema.sessionRuns.terminalId} IS NOT NULL`,
            inArray(schema.sessionRuns.id, candidateRunIds),
          ),
        )
    )
      .filter((run) => !liveTerminalIds.has(run.terminalId!.split(":").at(-1)!))
      .map((run) => run.id);
    if (staleRunIds.length === 0) return c.json({ ended: 0 });
    const result = await db
      .update(schema.sessionRuns)
      .set({ endedAt: now, endReason: "terminal_closed", lastSeenAt: now })
      .where(
        and(
          eq(schema.sessionRuns.deviceId, deviceId),
          isNull(schema.sessionRuns.endedAt),
          inArray(schema.sessionRuns.id, staleRunIds),
        ),
      );
    return c.json({ ended: result.meta.changes });
  });

  app.post("/api/pull-requests", async (c) => {
    const deviceId = requireDevice(c.get("deviceId"));
    const db = drizzle(c.env.DB, { schema });
    const value = await requestBody(c);
    const pr = v.parse(PullRequestInputSchema, value.pullRequest);
    const taskIssue = v.parse(v.optional(v.string()), value.task);
    const parentNumber = v.parse(v.optional(v.number()), value.parent);
    const parentPullRequest = v.parse(v.optional(PullRequestInputSchema), value.parentPullRequest);
    if (parentNumber === pr.number)
      throw new HTTPException(400, { message: "A pull request cannot be its own parent" });
    if (
      parentPullRequest &&
      (parentPullRequest.repo !== pr.repo || parentPullRequest.number !== parentNumber)
    )
      throw new HTTPException(400, { message: "Parent pull request does not match --parent" });
    const task = taskIssue ? await ensureTask(db, deviceId, taskIssue) : undefined;
    const current = value.context
      ? await resolveContext(db, deviceId, v.parse(ContextInputSchema, value.context))
      : undefined;
    const existing = await db
      .select({ id: schema.pullRequests.id })
      .from(schema.pullRequests)
      .where(and(eq(schema.pullRequests.repo, pr.repo), eq(schema.pullRequests.number, pr.number)))
      .get();
    let parent = parentNumber
      ? await db
          .select({ id: schema.pullRequests.id })
          .from(schema.pullRequests)
          .where(
            and(
              eq(schema.pullRequests.repo, pr.repo),
              eq(schema.pullRequests.number, parentNumber),
            ),
          )
          .get()
      : undefined;
    if (parentNumber && !parent && parentPullRequest) {
      parent = { id: id() };
      await db.insert(schema.pullRequests).values({
        id: parent.id,
        ...parentPullRequest,
        createdByDeviceId: deviceId,
      });
    }
    if (parentNumber && !parent)
      throw new HTTPException(404, {
        message: `Parent pull request not registered: ${pr.repo}#${parentNumber}`,
      });
    const pullRequestId = existing?.id ?? id();
    await db
      .insert(schema.pullRequests)
      .values({
        id: pullRequestId,
        ...pr,
        parentPrId: parent?.id,
        createdByDeviceId: deviceId,
      })
      .onConflictDoUpdate({
        target: [schema.pullRequests.repo, schema.pullRequests.number],
        set: {
          url: pr.url,
          headBranch: pr.headBranch,
          baseBranch: pr.baseBranch,
          state: pr.state,
          parentPrId: parent?.id,
          updatedAt: now,
        },
      });
    if (taskIssue) {
      await db
        .insert(schema.taskPullRequests)
        .values({ taskId: task!.id, pullRequestId })
        .onConflictDoNothing();
    }
    if (current?.checkoutId) {
      await db
        .insert(schema.sessionRunPullRequests)
        .values({
          deviceId,
          sessionRunId: current.runId,
          checkoutId: current.checkoutId,
          pullRequestId,
        })
        .onConflictDoNothing();
    }
    return c.json({ repo: pr.repo, number: pr.number });
  });

  app.delete("/api/pull-requests/:repo/:number/tasks/:issue", async (c) => {
    requireDevice(c.get("deviceId"));
    const db = drizzle(c.env.DB, { schema });
    const relation = await db
      .select({ taskId: schema.tasks.id, pullRequestId: schema.pullRequests.id })
      .from(schema.tasks)
      .innerJoin(schema.taskPullRequests, eq(schema.taskPullRequests.taskId, schema.tasks.id))
      .innerJoin(
        schema.pullRequests,
        eq(schema.pullRequests.id, schema.taskPullRequests.pullRequestId),
      )
      .where(
        and(
          eq(schema.tasks.issueId, c.req.param("issue")),
          eq(schema.pullRequests.repo, c.req.param("repo")),
          eq(schema.pullRequests.number, Number(c.req.param("number"))),
        ),
      )
      .get();
    if (!relation) throw new HTTPException(404, { message: "Pull request relationship not found" });
    await db
      .delete(schema.taskPullRequests)
      .where(
        and(
          eq(schema.taskPullRequests.taskId, relation.taskId),
          eq(schema.taskPullRequests.pullRequestId, relation.pullRequestId),
        ),
      );
    return c.json({ removed: true });
  });

  app.get("/api/pull-requests/sync-targets", async (c) => {
    requireDevice(c.get("deviceId"));
    const db = drizzle(c.env.DB, { schema });
    return c.json(
      await db
        .select({ repo: schema.pullRequests.repo, number: schema.pullRequests.number })
        .from(schema.pullRequests)
        .where(c.req.query("all") === "true" ? undefined : eq(schema.pullRequests.state, "open"))
        .orderBy(schema.pullRequests.repo, schema.pullRequests.number),
    );
  });

  app.post("/api/pull-requests/sync", async (c) => {
    requireDevice(c.get("deviceId"));
    const db = drizzle(c.env.DB, { schema });
    const value = await requestBody(c);
    const pullRequests = v.parse(v.array(PullRequestInputSchema), value.pullRequests);
    const updates = pullRequests.map((pr) =>
      db
        .update(schema.pullRequests)
        .set({
          url: pr.url,
          headBranch: pr.headBranch,
          baseBranch: pr.baseBranch,
          state: pr.state,
          updatedAt: now,
        })
        .where(
          and(eq(schema.pullRequests.repo, pr.repo), eq(schema.pullRequests.number, pr.number)),
        ),
    );
    if (updates.length > 0)
      await db.batch(updates as [(typeof updates)[number], ...typeof updates]);
    return c.json({ pullRequests: pullRequests.length });
  });

  app.post("/api/workpad-links", async (c) => {
    const deviceId = requireDevice(c.get("deviceId"));
    const db = drizzle(c.env.DB, { schema });
    const value = await requestBody(c);
    const current = await resolveContext(db, deviceId, v.parse(ContextInputSchema, value.context));
    if (!current.checkoutId) throw new HTTPException(400, { message: "No checkout found" });
    const issue = v.parse(v.optional(v.string()), value.task);
    const task = issue ? await ensureTask(db, deviceId, issue) : undefined;
    await db
      .insert(schema.workpadLinks)
      .values({
        id: id(),
        deviceId,
        taskId: task?.id,
        checkoutId: current.checkoutId,
        ref: v.parse(v.string(), value.ref),
      })
      .onConflictDoNothing();
    return c.json({ linked: true });
  });

  app.delete("/api/workpad-links", async (c) => {
    const deviceId = requireDevice(c.get("deviceId"));
    const db = drizzle(c.env.DB, { schema });
    const value = await requestBody(c);
    const current = await resolveContext(db, deviceId, v.parse(ContextInputSchema, value.context));
    const issue = v.parse(v.optional(v.string()), value.task);
    const task = issue
      ? await db
          .select({ id: schema.tasks.id })
          .from(schema.tasks)
          .where(eq(schema.tasks.issueId, issue))
          .get()
      : undefined;
    await db
      .delete(schema.workpadLinks)
      .where(
        and(
          eq(schema.workpadLinks.deviceId, deviceId),
          eq(schema.workpadLinks.checkoutId, current.checkoutId ?? ""),
          eq(schema.workpadLinks.ref, v.parse(v.string(), value.ref)),
          task ? eq(schema.workpadLinks.taskId, task.id) : isNull(schema.workpadLinks.taskId),
        ),
      );
    return c.json({ removed: true });
  });

  app.post("/api/conversation-links", async (c) => {
    const deviceId = requireDevice(c.get("deviceId"));
    const db = drizzle(c.env.DB, { schema });
    const value = await requestBody(c);
    const input = v.parse(ConversationLinkInputSchema, value);
    const current = await resolveContext(db, deviceId, input.context);
    const externalKey = slackConversationKey(input.url);
    if (!externalKey) throw new HTTPException(400, { message: "Invalid Slack thread URL" });
    await db
      .insert(schema.conversationLinks)
      .values({
        id: id(),
        deviceId,
        cliSessionId: current.sessionId,
        checkoutId: current.checkoutId,
        provider: "slack",
        externalKey,
        url: input.url,
      })
      .onConflictDoNothing();
    return c.json({ linked: true });
  });

  app.delete("/api/conversation-links", async (c) => {
    const deviceId = requireDevice(c.get("deviceId"));
    const db = drizzle(c.env.DB, { schema });
    const value = await requestBody(c);
    const input = v.parse(ConversationLinkInputSchema, value);
    if (!input.context.session) {
      throw new HTTPException(400, { message: "Could not resolve a session" });
    }
    const session = await db
      .select({ id: schema.cliSessions.id })
      .from(schema.cliSessions)
      .where(
        and(
          eq(schema.cliSessions.deviceId, deviceId),
          eq(schema.cliSessions.cli, input.context.session.cli),
          eq(schema.cliSessions.externalSessionId, input.context.session.externalSessionId),
        ),
      )
      .get();
    if (!session) return c.json({ removed: false }, 404);
    const externalKey = slackConversationKey(input.url);
    if (!externalKey) throw new HTTPException(400, { message: "Invalid Slack thread URL" });
    await db
      .delete(schema.conversationLinks)
      .where(
        and(
          eq(schema.conversationLinks.deviceId, deviceId),
          eq(schema.conversationLinks.cliSessionId, session.id),
          eq(schema.conversationLinks.provider, "slack"),
          eq(schema.conversationLinks.externalKey, externalKey),
        ),
      );
    return c.json({ removed: true });
  });

  app.get("/api/pull-requests", async (c) => {
    const db = drizzle(c.env.DB, { schema });
    const userId = c.get("userId");
    const deviceId = c.get("deviceId");
    const all = c.req.query("all") === "true" || c.req.query("global") === "true";
    const devices = visibleDeviceIds(userId, deviceId, all);
    const parentPullRequests = alias(schema.pullRequests, "parent_pull_requests");
    return c.json(
      decodeLocations(
        await db
          .select({
            repo: schema.pullRequests.repo,
            number: schema.pullRequests.number,
            url: schema.pullRequests.url,
            headBranch: schema.pullRequests.headBranch,
            baseBranch: schema.pullRequests.baseBranch,
            state: schema.pullRequests.state,
            parentNumber: parentPullRequests.number,
            linearIssueId: sql<string | null>`group_concat(${schema.tasks.issueId})`,
            createdAt: schema.pullRequests.createdAt,
            repoRoots: sql<string>`coalesce((select json_group_array(repo_root) from (
            select distinct c.repo_root as repo_root
            from session_run_pull_requests srp join checkouts c on c.id = srp.checkout_id
            where srp.pull_request_id = ${sql.raw('"pull_requests"."id"')}
              and srp.device_id in (${devices})
          )), '[]')`,
            worktreePaths: sql<string>`coalesce((select json_group_array(worktree_path) from (
            select distinct c.worktree_path as worktree_path
            from session_run_pull_requests srp join checkouts c on c.id = srp.checkout_id
            where srp.pull_request_id = ${sql.raw('"pull_requests"."id"')}
              and srp.device_id in (${devices})
          )), '[]')`,
          })
          .from(schema.pullRequests)
          .leftJoin(
            schema.taskPullRequests,
            eq(schema.taskPullRequests.pullRequestId, schema.pullRequests.id),
          )
          .leftJoin(schema.tasks, eq(schema.tasks.id, schema.taskPullRequests.taskId))
          .leftJoin(parentPullRequests, eq(parentPullRequests.id, schema.pullRequests.parentPrId))
          .where(pullRequestScope(userId, deviceId, all))
          .groupBy(schema.pullRequests.id)
          .orderBy(desc(schema.pullRequests.createdAt)),
      ),
    );
  });

  app.get("/api/pull-request-relationships", async (c) => {
    const repo = c.req.query("repo");
    const number = Number(c.req.query("number"));
    if (!repo || !Number.isInteger(number))
      throw new HTTPException(400, { message: "repo and number are required" });

    const userId = c.get("userId");
    const db = drizzle(c.env.DB, { schema });
    const parentPullRequests = alias(schema.pullRequests, "relationship_parent_pull_requests");
    const pullRequest = await db
      .select({
        id: schema.pullRequests.id,
        parentRepo: parentPullRequests.repo,
        parentNumber: parentPullRequests.number,
        parentUrl: parentPullRequests.url,
      })
      .from(schema.pullRequests)
      .leftJoin(parentPullRequests, eq(parentPullRequests.id, schema.pullRequests.parentPrId))
      .where(and(eq(schema.pullRequests.repo, repo), eq(schema.pullRequests.number, number)))
      .get();
    if (!pullRequest)
      throw new HTTPException(404, { message: `Pull request not found: ${repo}#${number}` });

    return c.json({
      parentPullRequest:
        pullRequest.parentRepo && pullRequest.parentNumber && pullRequest.parentUrl
          ? {
              repo: pullRequest.parentRepo,
              number: pullRequest.parentNumber,
              url: pullRequest.parentUrl,
            }
          : null,
      childPullRequests: await db
        .select({
          repo: schema.pullRequests.repo,
          number: schema.pullRequests.number,
          url: schema.pullRequests.url,
          state: schema.pullRequests.state,
        })
        .from(schema.pullRequests)
        .where(eq(schema.pullRequests.parentPrId, pullRequest.id))
        .orderBy(schema.pullRequests.number),
      tasks: await db
        .select({
          issueId: schema.tasks.issueId,
          title: schema.tasks.title,
          status: schema.tasks.status,
        })
        .from(schema.taskPullRequests)
        .innerJoin(schema.tasks, eq(schema.tasks.id, schema.taskPullRequests.taskId))
        .where(eq(schema.taskPullRequests.pullRequestId, pullRequest.id))
        .orderBy(schema.tasks.issueId),
      runs: await db
        .selectDistinct({
          id: schema.sessionRuns.id,
          cli: schema.cliSessions.cli,
          externalSessionId: schema.cliSessions.externalSessionId,
          terminalId: schema.sessionRuns.terminalId,
          startedAt: schema.sessionRuns.startedAt,
          endedAt: schema.sessionRuns.endedAt,
        })
        .from(schema.sessionRunPullRequests)
        .innerJoin(
          schema.sessionRuns,
          eq(schema.sessionRuns.id, schema.sessionRunPullRequests.sessionRunId),
        )
        .innerJoin(schema.cliSessions, eq(schema.cliSessions.id, schema.sessionRuns.cliSessionId))
        .where(
          and(
            eq(schema.sessionRunPullRequests.pullRequestId, pullRequest.id),
            deviceScope(schema.sessionRunPullRequests.deviceId, userId),
          ),
        )
        .orderBy(schema.sessionRuns.startedAt),
      checkouts: await db
        .selectDistinct({
          id: schema.checkouts.id,
          repoRoot: schema.checkouts.repoRoot,
          worktreePath: schema.checkouts.worktreePath,
          branch: schema.checkouts.branch,
        })
        .from(schema.sessionRunPullRequests)
        .innerJoin(
          schema.checkouts,
          eq(schema.checkouts.id, schema.sessionRunPullRequests.checkoutId),
        )
        .where(
          and(
            eq(schema.sessionRunPullRequests.pullRequestId, pullRequest.id),
            deviceScope(schema.sessionRunPullRequests.deviceId, userId),
          ),
        )
        .orderBy(schema.checkouts.worktreePath),
    });
  });

  app.get("/api/device/resources/:resource", async (c) => {
    const userId = c.get("userId");
    const deviceId = c.get("deviceId");
    const all = c.req.query("all") === "true" || c.req.query("global") === "true";
    const devices = visibleDeviceIds(userId, deviceId, all);
    const db = drizzle(c.env.DB, { schema });
    switch (c.req.param("resource")) {
      case "sessions":
        return c.json(
          decodeLocations(
            await db
              .select({
                id: schema.cliSessions.id,
                session: sql<string>`${schema.cliSessions.cli} || ':' || ${schema.cliSessions.externalSessionId}`,
                cli: schema.cliSessions.cli,
                externalSessionId: schema.cliSessions.externalSessionId,
                initialPrompt: schema.cliSessions.initialPrompt,
                status: sql<string>`CASE WHEN EXISTS (
                  SELECT 1 FROM session_runs sr
                  WHERE sr.cli_session_id = ${schema.cliSessions.id} AND sr.ended_at IS NULL
                ) THEN 'active' ELSE 'ended' END`,
                createdAt: schema.cliSessions.createdAt,
                updatedAt: sql<string>`coalesce(${schema.cliSessions.updatedAt}, ${schema.cliSessions.createdAt})`,
                repoRoots: sql<string>`coalesce((select json_group_array(repo_root) from (
                select distinct c.repo_root as repo_root
                from session_runs sr
                join session_run_checkouts src on src.session_run_id = sr.id
                join checkouts c on c.id = src.checkout_id
                where sr.cli_session_id = ${sql.raw('"cli_sessions"."id"')}
                  and sr.device_id in (${devices})
              )), '[]')`,
                worktreePaths: sql<string>`coalesce((select json_group_array(worktree_path) from (
                select distinct c.worktree_path as worktree_path
                from session_runs sr
                join session_run_checkouts src on src.session_run_id = sr.id
                join checkouts c on c.id = src.checkout_id
                where sr.cli_session_id = ${sql.raw('"cli_sessions"."id"')}
                  and sr.device_id in (${devices})
              )), '[]')`,
              })
              .from(schema.cliSessions)
              .where(scopedDevice(schema.cliSessions.deviceId, userId, deviceId, all))
              .orderBy(
                desc(
                  sql`coalesce(${schema.cliSessions.updatedAt}, ${schema.cliSessions.createdAt})`,
                ),
              ),
          ),
        );
      case "runs":
      case "terminals":
        return c.json(
          decodeLocations(
            await db
              .select({
                id: schema.sessionRuns.id,
                runId: schema.sessionRuns.id,
                sessionId: schema.sessionRuns.cliSessionId,
                session: sql<string>`${schema.cliSessions.cli} || ':' || ${schema.cliSessions.externalSessionId}`,
                itermSessionId: schema.sessionRuns.terminalId,
                startedCwd: schema.sessionRuns.startedCwd,
                source: schema.sessionRuns.source,
                status: sql<string>`CASE WHEN ${schema.sessionRuns.endedAt} IS NULL THEN 'active' ELSE 'ended' END`,
                startedAt: schema.sessionRuns.startedAt,
                lastSeenAt: schema.sessionRuns.lastSeenAt,
                endedAt: schema.sessionRuns.endedAt,
                endReason: schema.sessionRuns.endReason,
                repoRoots: sql<string>`coalesce((select json_group_array(repo_root) from (
                select distinct c.repo_root as repo_root
                from session_run_checkouts src join checkouts c on c.id = src.checkout_id
                where src.session_run_id = ${sql.raw('"session_runs"."id"')}
                  and src.device_id in (${devices})
              )), '[]')`,
                worktreePaths: sql<string>`coalesce((select json_group_array(worktree_path) from (
                select distinct c.worktree_path as worktree_path
                from session_run_checkouts src join checkouts c on c.id = src.checkout_id
                where src.session_run_id = ${sql.raw('"session_runs"."id"')}
                  and src.device_id in (${devices})
              )), '[]')`,
              })
              .from(schema.sessionRuns)
              .innerJoin(
                schema.cliSessions,
                eq(schema.cliSessions.id, schema.sessionRuns.cliSessionId),
              )
              .where(
                and(
                  scopedDevice(schema.sessionRuns.deviceId, userId, deviceId, all),
                  c.req.param("resource") === "terminals"
                    ? sql`${schema.sessionRuns.terminalId} IS NOT NULL`
                    : undefined,
                ),
              )
              .orderBy(desc(schema.sessionRuns.lastSeenAt)),
          ),
        );
      case "checkouts":
      case "branches":
        return c.json(
          await db
            .select({
              id: schema.checkouts.id,
              repoRoot: schema.checkouts.repoRoot,
              worktreePath: schema.checkouts.worktreePath,
              branch: schema.checkouts.branch,
              createdAt: schema.checkouts.createdAt,
            })
            .from(schema.checkouts)
            .where(
              and(
                scopedDevice(schema.checkouts.deviceId, userId, deviceId, all),
                c.req.param("resource") === "branches"
                  ? sql`${schema.checkouts.branch} IS NOT NULL`
                  : undefined,
              ),
            )
            .orderBy(desc(schema.checkouts.createdAt)),
        );
      case "executions":
        return c.json(
          await db
            .select({
              id: schema.executions.id,
              linearIssueId: schema.tasks.issueId,
              session: sql<string>`${schema.cliSessions.cli} || ':' || ${schema.cliSessions.externalSessionId}`,
              runId: schema.executions.sessionRunId,
              checkoutId: schema.executions.checkoutId,
              status: schema.executions.status,
              startedAt: schema.executions.startedAt,
              finishedAt: schema.executions.finishedAt,
              repoRoot: schema.checkouts.repoRoot,
              worktreePath: schema.checkouts.worktreePath,
            })
            .from(schema.executions)
            .innerJoin(schema.tasks, eq(schema.tasks.id, schema.executions.taskId))
            .innerJoin(
              schema.cliSessions,
              eq(schema.cliSessions.id, schema.executions.cliSessionId),
            )
            .leftJoin(schema.checkouts, eq(schema.checkouts.id, schema.executions.checkoutId))
            .where(scopedDevice(schema.executions.deviceId, userId, deviceId, all))
            .orderBy(desc(schema.executions.startedAt)),
        );
      case "links": {
        const workpadLinks = await db
          .select({
            id: schema.workpadLinks.id,
            linearIssueId: schema.tasks.issueId,
            repoRoot: schema.checkouts.repoRoot,
            worktreePath: schema.checkouts.worktreePath,
            kind: sql<string>`'workpad'`,
            ref: schema.workpadLinks.ref,
            createdAt: schema.workpadLinks.createdAt,
          })
          .from(schema.workpadLinks)
          .leftJoin(schema.tasks, eq(schema.tasks.id, schema.workpadLinks.taskId))
          .innerJoin(schema.checkouts, eq(schema.checkouts.id, schema.workpadLinks.checkoutId))
          .where(scopedDevice(schema.workpadLinks.deviceId, userId, deviceId, all));
        const conversationLinks = await db
          .select({
            id: schema.conversationLinks.id,
            linearIssueId: sql<string | null>`null`,
            repoRoot: schema.checkouts.repoRoot,
            worktreePath: schema.checkouts.worktreePath,
            kind: sql<string>`'conversation'`,
            ref: schema.conversationLinks.url,
            createdAt: schema.conversationLinks.createdAt,
          })
          .from(schema.conversationLinks)
          .leftJoin(schema.checkouts, eq(schema.checkouts.id, schema.conversationLinks.checkoutId))
          .where(scopedDevice(schema.conversationLinks.deviceId, userId, deviceId, all));
        return c.json(
          [...workpadLinks, ...conversationLinks].toSorted((a, b) =>
            b.createdAt.localeCompare(a.createdAt),
          ),
        );
      }
      case "repos":
        return c.json(
          await db
            .select({
              repoRoot: schema.checkouts.repoRoot,
              worktreeCount: sql<number>`count(DISTINCT ${schema.checkouts.worktreePath})`,
              updatedAt: sql<string>`max(${schema.checkouts.createdAt})`,
            })
            .from(schema.checkouts)
            .where(scopedDevice(schema.checkouts.deviceId, userId, deviceId, all))
            .groupBy(schema.checkouts.repoRoot)
            .orderBy(desc(sql`max(${schema.checkouts.createdAt})`)),
        );
      default:
        throw new HTTPException(404);
    }
  });

  app.get("/api/focus-targets", async (c) => {
    const userId = c.get("userId");
    const deviceId = c.get("deviceId");
    const db = drizzle(c.env.DB, { schema });
    const runs = await db
      .select({
        id: schema.sessionRuns.id,
        session: sql<string>`${schema.cliSessions.cli} || ':' || ${schema.cliSessions.externalSessionId}`,
        itermSessionId: schema.sessionRuns.terminalId,
        startedCwd: schema.sessionRuns.startedCwd,
      })
      .from(schema.sessionRuns)
      .innerJoin(schema.cliSessions, eq(schema.cliSessions.id, schema.sessionRuns.cliSessionId))
      .where(
        and(
          scopedDevice(schema.sessionRuns.deviceId, userId, deviceId, false),
          isNull(schema.sessionRuns.endedAt),
          sql`${schema.sessionRuns.terminalId} IS NOT NULL`,
        ),
      )
      .orderBy(desc(schema.sessionRuns.lastSeenAt));
    return c.json(
      await Promise.all(
        runs.map(async (run) => {
          const taskRows = await db
            .selectDistinct({ issueId: schema.tasks.issueId })
            .from(schema.executions)
            .innerJoin(schema.tasks, eq(schema.tasks.id, schema.executions.taskId))
            .where(eq(schema.executions.sessionRunId, run.id));
          const checkoutRows = await db
            .selectDistinct({
              repoRoot: schema.checkouts.repoRoot,
              branch: schema.checkouts.branch,
            })
            .from(schema.sessionRunCheckouts)
            .innerJoin(
              schema.checkouts,
              eq(schema.checkouts.id, schema.sessionRunCheckouts.checkoutId),
            )
            .where(eq(schema.sessionRunCheckouts.sessionRunId, run.id));
          const prRows = await db
            .selectDistinct({
              label: sql<string>`${schema.pullRequests.repo} || '#' || ${schema.pullRequests.number}`,
              url: schema.pullRequests.url,
              branch: schema.pullRequests.headBranch,
            })
            .from(schema.sessionRunPullRequests)
            .innerJoin(
              schema.pullRequests,
              eq(schema.pullRequests.id, schema.sessionRunPullRequests.pullRequestId),
            )
            .where(eq(schema.sessionRunPullRequests.sessionRunId, run.id));
          return {
            id: run.id,
            session: run.session,
            itermSessionId: run.itermSessionId,
            startedCwd: run.startedCwd,
            taskIds: taskRows.map((row) => row.issueId).join(" "),
            repoRoots: checkoutRows.map((row) => row.repoRoot),
            branches: [...checkoutRows.map((row) => row.branch), ...prRows.map((row) => row.branch)]
              .filter(Boolean)
              .join(" "),
            pullRequests: prRows.map((row) => row.label).join(" "),
            prUrls: prRows.map((row) => row.url).join(" "),
          };
        }),
      ),
    );
  });

  app.get("/api/show", async (c) => {
    const userId = c.get("userId");
    const db = drizzle(c.env.DB, { schema });
    const issue = c.req.query("task");
    const worktree = c.req.query("worktree");
    const session = c.req.query("session");
    const taskRows = issue
      ? await db
          .select({
            id: schema.tasks.id,
            linearIssueId: schema.tasks.issueId,
            title: schema.tasks.title,
            status: schema.tasks.status,
          })
          .from(schema.tasks)
          .where(eq(schema.tasks.issueId, issue))
      : await db
          .selectDistinct({
            id: schema.tasks.id,
            linearIssueId: schema.tasks.issueId,
            title: schema.tasks.title,
            status: schema.tasks.status,
          })
          .from(schema.tasks)
          .innerJoin(schema.executions, eq(schema.executions.taskId, schema.tasks.id))
          .innerJoin(schema.cliSessions, eq(schema.cliSessions.id, schema.executions.cliSessionId))
          .leftJoin(schema.checkouts, eq(schema.checkouts.id, schema.executions.checkoutId))
          .where(
            and(
              deviceScope(schema.executions.deviceId, userId),
              worktree ? eq(schema.checkouts.worktreePath, worktree) : undefined,
              session ? eq(schema.cliSessions.externalSessionId, session) : undefined,
            ),
          );
    if (issue && taskRows.length === 0)
      throw new HTTPException(404, { message: `Task not found: ${issue}` });
    const parentPullRequests = alias(schema.pullRequests, "show_parent_pull_requests");
    return c.json(
      await Promise.all(
        taskRows.map(async (task) => ({
          linearIssueId: task.linearIssueId,
          title: task.title,
          status: task.status,
          executions: await db
            .select({
              id: schema.executions.id,
              status: schema.executions.status,
              sessionRunId: schema.executions.sessionRunId,
              cli: schema.cliSessions.cli,
              externalSessionId: schema.cliSessions.externalSessionId,
              worktreePath: schema.checkouts.worktreePath,
              branch: schema.checkouts.branch,
            })
            .from(schema.executions)
            .innerJoin(
              schema.cliSessions,
              eq(schema.cliSessions.id, schema.executions.cliSessionId),
            )
            .leftJoin(schema.checkouts, eq(schema.checkouts.id, schema.executions.checkoutId))
            .where(
              and(
                deviceScope(schema.executions.deviceId, userId),
                eq(schema.executions.taskId, task.id),
              ),
            )
            .orderBy(schema.executions.startedAt),
          pullRequests: await db
            .select({
              repo: schema.pullRequests.repo,
              number: schema.pullRequests.number,
              url: schema.pullRequests.url,
              headBranch: schema.pullRequests.headBranch,
              baseBranch: schema.pullRequests.baseBranch,
              state: schema.pullRequests.state,
              parentNumber: parentPullRequests.number,
            })
            .from(schema.taskPullRequests)
            .innerJoin(
              schema.pullRequests,
              eq(schema.pullRequests.id, schema.taskPullRequests.pullRequestId),
            )
            .leftJoin(parentPullRequests, eq(parentPullRequests.id, schema.pullRequests.parentPrId))
            .where(eq(schema.taskPullRequests.taskId, task.id))
            .orderBy(schema.pullRequests.number),
          links: [
            ...(await db
              .select({ kind: sql<string>`'workpad'`, ref: schema.workpadLinks.ref })
              .from(schema.workpadLinks)
              .where(
                and(
                  deviceScope(schema.workpadLinks.deviceId, userId),
                  eq(schema.workpadLinks.taskId, task.id),
                ),
              )
              .orderBy(schema.workpadLinks.createdAt)),
            ...(await db
              .selectDistinct({
                kind: sql<string>`'conversation'`,
                ref: schema.conversationLinks.url,
              })
              .from(schema.conversationLinks)
              .innerJoin(
                schema.executions,
                eq(schema.executions.cliSessionId, schema.conversationLinks.cliSessionId),
              )
              .where(
                and(
                  deviceScope(schema.conversationLinks.deviceId, userId),
                  eq(schema.executions.taskId, task.id),
                ),
              )
              .orderBy(schema.conversationLinks.createdAt)),
          ],
        })),
      ),
    );
  });

  app.get("/", async (c) => {
    const db = drizzle(c.env.DB, { schema });
    const userId = c.get("userId");
    const selectedDevice = c.req.query("device");
    const selectedRepository = c.req.query("repo");
    const selectedWorktree = c.req.query("worktree");
    const conversationLinkRows = await db
      .select({
        id: schema.conversationLinks.id,
        cliSessionId: schema.conversationLinks.cliSessionId,
        url: schema.conversationLinks.url,
        repoRoot: schema.checkouts.repoRoot,
        worktreePath: schema.checkouts.worktreePath,
        createdAt: schema.conversationLinks.createdAt,
        deviceId: schema.conversationLinks.deviceId,
        deviceName: schema.devices.name,
      })
      .from(schema.conversationLinks)
      .leftJoin(schema.checkouts, eq(schema.checkouts.id, schema.conversationLinks.checkoutId))
      .innerJoin(schema.devices, eq(schema.devices.id, schema.conversationLinks.deviceId))
      .where(deviceScope(schema.conversationLinks.deviceId, userId))
      .orderBy(desc(schema.conversationLinks.createdAt));
    const runRows = await db
      .select({
        id: schema.sessionRuns.id,
        cliSessionId: schema.sessionRuns.cliSessionId,
        cli: schema.cliSessions.cli,
        externalSessionId: schema.cliSessions.externalSessionId,
        terminalId: schema.sessionRuns.terminalId,
        startedCwd: schema.sessionRuns.startedCwd,
        source: schema.sessionRuns.source,
        startedAt: schema.sessionRuns.startedAt,
        updatedAt: schema.sessionRuns.lastSeenAt,
        endedAt: schema.sessionRuns.endedAt,
        deviceId: schema.sessionRuns.deviceId,
        deviceName: schema.devices.name,
        repoRoots: sql<string>`coalesce((select json_group_array(repo_root) from (
          select distinct c.repo_root as repo_root
          from session_run_checkouts src
          join checkouts c on c.id = src.checkout_id
          where src.session_run_id = ${sql.raw('"session_runs"."id"')}
            and src.device_id in (select id from devices where user_id = ${userId})
        )), '[]')`,
        worktreePaths: sql<string>`coalesce((select json_group_array(worktree_path) from (
          select distinct c.worktree_path as worktree_path
          from session_run_checkouts src
          join checkouts c on c.id = src.checkout_id
          where src.session_run_id = ${sql.raw('"session_runs"."id"')}
            and src.device_id in (select id from devices where user_id = ${userId})
        )), '[]')`,
      })
      .from(schema.sessionRuns)
      .innerJoin(schema.cliSessions, eq(schema.cliSessions.id, schema.sessionRuns.cliSessionId))
      .innerJoin(schema.devices, eq(schema.devices.id, schema.sessionRuns.deviceId))
      .where(deviceScope(schema.sessionRuns.deviceId, userId))
      .orderBy(desc(schema.sessionRuns.lastSeenAt));
    const taskRows = await db
      .select({
        issueId: schema.tasks.issueId,
        title: schema.tasks.title,
        status: schema.tasks.status,
        updatedAt: schema.tasks.updatedAt,
        deviceIds: sql<string>`coalesce((select json_group_array(device_id) from (
          select distinct e.device_id as device_id from executions e
          where e.task_id = ${sql.raw('"tasks"."id"')}
            and e.device_id in (select id from devices where user_id = ${userId})
          union
          select distinct w.device_id as device_id from workpad_links w
          where w.task_id = ${sql.raw('"tasks"."id"')}
            and w.device_id in (select id from devices where user_id = ${userId})
        )), '[]')`,
        deviceNames: sql<string>`coalesce((select json_group_array(device_name) from (
          select distinct d.name as device_name from executions e
          join devices d on d.id = e.device_id
          where e.task_id = ${sql.raw('"tasks"."id"')}
            and e.device_id in (select id from devices where user_id = ${userId})
          union
          select distinct d.name as device_name from workpad_links w
          join devices d on d.id = w.device_id
          where w.task_id = ${sql.raw('"tasks"."id"')}
            and w.device_id in (select id from devices where user_id = ${userId})
        )), '[]')`,
        repoRoots: sql<string>`coalesce((select json_group_array(repo_root) from (
          select distinct c.repo_root as repo_root from executions e
          join checkouts c on c.id = e.checkout_id
          where e.task_id = ${sql.raw('"tasks"."id"')}
            and e.device_id in (select id from devices where user_id = ${userId})
          union
          select distinct c.repo_root as repo_root from workpad_links w
          join checkouts c on c.id = w.checkout_id
          where w.task_id = ${sql.raw('"tasks"."id"')}
            and w.device_id in (select id from devices where user_id = ${userId})
        )), '[]')`,
        worktreePaths: sql<string>`coalesce((select json_group_array(worktree_path) from (
          select distinct c.worktree_path as worktree_path from executions e
          join checkouts c on c.id = e.checkout_id
          where e.task_id = ${sql.raw('"tasks"."id"')}
            and e.device_id in (select id from devices where user_id = ${userId})
          union
          select distinct c.worktree_path as worktree_path from workpad_links w
          join checkouts c on c.id = w.checkout_id
          where w.task_id = ${sql.raw('"tasks"."id"')}
            and w.device_id in (select id from devices where user_id = ${userId})
        )), '[]')`,
      })
      .from(schema.tasks)
      .orderBy(desc(schema.tasks.updatedAt));
    const pullRequestRows = await db
      .select({
        repo: schema.pullRequests.repo,
        number: schema.pullRequests.number,
        url: schema.pullRequests.url,
        headBranch: schema.pullRequests.headBranch,
        baseBranch: schema.pullRequests.baseBranch,
        state: schema.pullRequests.state,
        updatedAt: schema.pullRequests.updatedAt,
        deviceIds: sql<string>`coalesce((select json_group_array(device_id) from (
          select distinct srp.device_id as device_id from session_run_pull_requests srp
          where srp.pull_request_id = ${sql.raw('"pull_requests"."id"')}
            and srp.device_id in (select id from devices where user_id = ${userId})
        )), '[]')`,
        deviceNames: sql<string>`coalesce((select json_group_array(device_name) from (
          select distinct d.name as device_name from session_run_pull_requests srp
          join devices d on d.id = srp.device_id
          where srp.pull_request_id = ${sql.raw('"pull_requests"."id"')}
            and srp.device_id in (select id from devices where user_id = ${userId})
        )), '[]')`,
        repoRoots: sql<string>`coalesce((select json_group_array(repo_root) from (
          select distinct c.repo_root as repo_root from session_run_pull_requests srp
          join checkouts c on c.id = srp.checkout_id
          where srp.pull_request_id = ${sql.raw('"pull_requests"."id"')}
            and srp.device_id in (select id from devices where user_id = ${userId})
        )), '[]')`,
        worktreePaths: sql<string>`coalesce((select json_group_array(worktree_path) from (
          select distinct c.worktree_path as worktree_path from session_run_pull_requests srp
          join checkouts c on c.id = srp.checkout_id
          where srp.pull_request_id = ${sql.raw('"pull_requests"."id"')}
            and srp.device_id in (select id from devices where user_id = ${userId})
        )), '[]')`,
      })
      .from(schema.pullRequests)
      .orderBy(desc(schema.pullRequests.updatedAt));
    return c.render("Tasks/Index", {
      user: { email: c.get("principal").email ?? null },
      runs: runRows.map((run) => ({
        id: run.id,
        cliSessionId: run.cliSessionId,
        cli: run.cli,
        externalSessionId: run.externalSessionId,
        terminalId: run.terminalId,
        startedCwd: run.startedCwd,
        source: run.source,
        status: run.endedAt ? "ended" : "active",
        startedAt: run.startedAt,
        updatedAt: run.updatedAt,
        endedAt: run.endedAt,
        deviceIds: [run.deviceId],
        deviceNames: [run.deviceName],
        repoRoots: JSON.parse(run.repoRoots),
        worktreePaths: JSON.parse(run.worktreePaths),
      })),
      conversationLinks: conversationLinkRows.map((conversationLink) => ({
        id: conversationLink.id,
        cliSessionId: conversationLink.cliSessionId,
        url: conversationLink.url,
        repoRoot: conversationLink.repoRoot,
        worktreePath: conversationLink.worktreePath,
        createdAt: conversationLink.createdAt,
        deviceIds: [conversationLink.deviceId],
        deviceNames: [conversationLink.deviceName],
      })),
      tasks: taskRows.map((task) => ({
        issueId: task.issueId,
        title: task.title,
        status: task.status,
        updatedAt: task.updatedAt,
        deviceIds: JSON.parse(task.deviceIds),
        deviceNames: JSON.parse(task.deviceNames),
        repoRoots: JSON.parse(task.repoRoots),
        worktreePaths: JSON.parse(task.worktreePaths),
      })),
      pullRequests: pullRequestRows.map((pullRequest) => ({
        repo: pullRequest.repo,
        number: pullRequest.number,
        url: pullRequest.url,
        headBranch: pullRequest.headBranch,
        baseBranch: pullRequest.baseBranch,
        state: pullRequest.state,
        updatedAt: pullRequest.updatedAt,
        deviceIds: JSON.parse(pullRequest.deviceIds),
        deviceNames: JSON.parse(pullRequest.deviceNames),
        repoRoots: JSON.parse(pullRequest.repoRoots),
        worktreePaths: JSON.parse(pullRequest.worktreePaths),
      })),
      devices: await db
        .select({
          id: schema.devices.id,
          name: schema.devices.name,
        })
        .from(schema.devices)
        .where(deviceScope(schema.devices.id, userId))
        .orderBy(
          desc(sql`${schema.devices.id} = ${selectedDevice ?? ""}`),
          desc(schema.devices.lastSeenAt),
        )
        .limit(50),
      repositories: await db
        .select({
          repoRoot: schema.checkouts.repoRoot,
        })
        .from(schema.checkouts)
        .where(deviceScope(schema.checkouts.deviceId, userId))
        .groupBy(schema.checkouts.repoRoot)
        .orderBy(
          desc(sql`${schema.checkouts.repoRoot} = ${selectedRepository ?? ""}`),
          desc(sql`max(${schema.checkouts.createdAt})`),
        )
        .limit(50),
      worktrees: await db
        .selectDistinct({
          worktreePath: schema.checkouts.worktreePath,
        })
        .from(schema.checkouts)
        .where(deviceScope(schema.checkouts.deviceId, userId))
        .orderBy(
          desc(sql`${schema.checkouts.worktreePath} = ${selectedWorktree ?? ""}`),
          schema.checkouts.worktreePath,
        )
        .limit(50),
    });
  });

  app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));
  return app;
}
