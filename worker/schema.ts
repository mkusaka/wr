import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";

const timestamps = {
  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
};

export const users = sqliteTable("users", {
  id: text().primaryKey(),
  accessSubject: text("access_subject").notNull().unique(),
  email: text(),
  ...timestamps,
  lastSeenAt: text("last_seen_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const devices = sqliteTable("devices", {
  id: text().primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  name: text().notNull(),
  ...timestamps,
  lastSeenAt: text("last_seen_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const tasks = sqliteTable(
  "tasks",
  {
    id: text().primaryKey(),
    issueId: text("issue_id").notNull().unique(),
    title: text(),
    status: text({ enum: ["open", "active", "done", "cancelled"] })
      .notNull()
      .default("open"),
    createdByDeviceId: text("created_by_device_id").references(() => devices.id),
    ...timestamps,
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    check("tasks_status_check", sql`${table.status} IN ('open','active','done','cancelled')`),
  ],
);

export const cliSessions = sqliteTable(
  "cli_sessions",
  {
    id: text().primaryKey(),
    deviceId: text("device_id")
      .notNull()
      .references(() => devices.id),
    cli: text({ enum: ["codex", "claude", "devin", "pi"] }).notNull(),
    externalSessionId: text("external_session_id").notNull(),
    initialPrompt: text("initial_prompt"),
    ...timestamps,
    updatedAt: text("updated_at"),
  },
  (table) => [
    uniqueIndex("cli_sessions_device_cli_external_unique").on(
      table.deviceId,
      table.cli,
      table.externalSessionId,
    ),
    check("cli_sessions_cli_check", sql`${table.cli} IN ('codex','claude','devin','pi')`),
  ],
);

export const sessionRuns = sqliteTable(
  "session_runs",
  {
    id: text().primaryKey(),
    deviceId: text("device_id")
      .notNull()
      .references(() => devices.id),
    cliSessionId: text("cli_session_id")
      .notNull()
      .references(() => cliSessions.id),
    terminalId: text("terminal_id"),
    startedCwd: text("started_cwd"),
    source: text(),
    startedAt: text("started_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    lastSeenAt: text("last_seen_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    endedAt: text("ended_at"),
    endReason: text("end_reason", {
      enum: ["session_end", "superseded", "terminal_closed"],
    }),
  },
  (table) => [
    index("session_runs_device_active_idx").on(table.deviceId, table.endedAt, table.lastSeenAt),
  ],
);

export const checkouts = sqliteTable(
  "checkouts",
  {
    id: text().primaryKey(),
    deviceId: text("device_id")
      .notNull()
      .references(() => devices.id),
    repoRoot: text("repo_root").notNull(),
    worktreePath: text("worktree_path").notNull(),
    branch: text(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("checkouts_device_repo_worktree_unique").on(
      table.deviceId,
      table.repoRoot,
      table.worktreePath,
    ),
    index("checkouts_device_repo_idx").on(table.deviceId, table.repoRoot),
  ],
);

export const sessionRunCheckouts = sqliteTable(
  "session_run_checkouts",
  {
    deviceId: text("device_id")
      .notNull()
      .references(() => devices.id),
    sessionRunId: text("session_run_id")
      .notNull()
      .references(() => sessionRuns.id),
    checkoutId: text("checkout_id")
      .notNull()
      .references(() => checkouts.id),
    lastSeenAt: text("last_seen_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [primaryKey({ columns: [table.deviceId, table.sessionRunId, table.checkoutId] })],
);

export const executions = sqliteTable(
  "executions",
  {
    id: text().primaryKey(),
    deviceId: text("device_id")
      .notNull()
      .references(() => devices.id),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    cliSessionId: text("cli_session_id")
      .notNull()
      .references(() => cliSessions.id),
    sessionRunId: text("session_run_id").references(() => sessionRuns.id),
    checkoutId: text("checkout_id").references(() => checkouts.id),
    status: text({ enum: ["active", "finished", "abandoned"] })
      .notNull()
      .default("active"),
    startedAt: text("started_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    finishedAt: text("finished_at"),
  },
  (table) => [
    index("executions_device_status_idx").on(table.deviceId, table.status),
    check("executions_status_check", sql`${table.status} IN ('active','finished','abandoned')`),
  ],
);

export const pullRequests = sqliteTable(
  "pull_requests",
  {
    id: text().primaryKey(),
    repo: text().notNull(),
    number: integer().notNull(),
    url: text().notNull(),
    headBranch: text("head_branch").notNull(),
    baseBranch: text("base_branch").notNull(),
    state: text({ enum: ["open", "closed", "merged"] }).notNull(),
    parentPrId: text("parent_pr_id").references((): AnySQLiteColumn => pullRequests.id),
    createdByDeviceId: text("created_by_device_id").references(() => devices.id),
    ...timestamps,
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("pull_requests_repo_number_unique").on(table.repo, table.number),
    check("pull_requests_state_check", sql`${table.state} IN ('open','closed','merged')`),
  ],
);

export const taskPullRequests = sqliteTable(
  "task_pull_requests",
  {
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    pullRequestId: text("pull_request_id")
      .notNull()
      .references(() => pullRequests.id),
    ...timestamps,
  },
  (table) => [primaryKey({ columns: [table.taskId, table.pullRequestId] })],
);

export const sessionRunPullRequests = sqliteTable(
  "session_run_pull_requests",
  {
    deviceId: text("device_id")
      .notNull()
      .references(() => devices.id),
    sessionRunId: text("session_run_id")
      .notNull()
      .references(() => sessionRuns.id),
    checkoutId: text("checkout_id")
      .notNull()
      .references(() => checkouts.id),
    pullRequestId: text("pull_request_id")
      .notNull()
      .references(() => pullRequests.id),
    ...timestamps,
  },
  (table) => [
    primaryKey({
      columns: [table.deviceId, table.sessionRunId, table.checkoutId, table.pullRequestId],
    }),
  ],
);

export const workpadLinks = sqliteTable(
  "workpad_links",
  {
    id: text().primaryKey(),
    deviceId: text("device_id")
      .notNull()
      .references(() => devices.id),
    taskId: text("task_id").references(() => tasks.id),
    checkoutId: text("checkout_id")
      .notNull()
      .references(() => checkouts.id),
    ref: text().notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("workpad_links_device_task_checkout_ref_unique").on(
      table.deviceId,
      table.taskId,
      table.checkoutId,
      table.ref,
    ),
  ],
);

export const conversationLinks = sqliteTable(
  "conversation_links",
  {
    id: text().primaryKey(),
    deviceId: text("device_id")
      .notNull()
      .references(() => devices.id),
    cliSessionId: text("cli_session_id")
      .notNull()
      .references(() => cliSessions.id),
    checkoutId: text("checkout_id").references(() => checkouts.id),
    provider: text({ enum: ["slack"] }).notNull(),
    externalKey: text("external_key").notNull(),
    url: text().notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("conversation_links_device_session_provider_external_unique").on(
      table.deviceId,
      table.cliSessionId,
      table.provider,
      table.externalKey,
    ),
  ],
);
