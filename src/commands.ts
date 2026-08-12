import type { Database } from "bun:sqlite";
import { existsSync, realpathSync } from "node:fs";
import * as v from "valibot";
import type { CurrentContext } from "./context.ts";
import { ensureCheckout, touchRunCheckout } from "./context.ts";
import { discoverCheckout } from "./git.ts";
import { newId } from "./db.ts";
import {
  CliSchema,
  DbIntegerSchema,
  ExecutionStatusSchema,
  IdRowSchema,
  NonEmptyStringSchema,
  PullRequestListSchema,
  PullRequestSchema,
  RepositorySchema,
  TaskStatusSchema,
  type PullRequestData,
} from "./validation.ts";

const TaskRowSchema = v.object({
  id: NonEmptyStringSchema,
  linear_issue_id: NonEmptyStringSchema,
  title: v.nullable(v.string()),
  status: TaskStatusSchema,
});
type TaskRow = v.InferOutput<typeof TaskRowSchema>;

const ShowExecutionSchema = v.object({
  status: ExecutionStatusSchema,
  cli: CliSchema,
  external_session_id: NonEmptyStringSchema,
  worktree_path: v.nullable(v.string()),
  branch: v.nullable(v.string()),
});
const ShowPullRequestSchema = v.object({
  repo: NonEmptyStringSchema,
  number: DbIntegerSchema,
  url: v.nullable(v.string()),
  head_branch: v.nullable(v.string()),
  base_branch: v.nullable(v.string()),
  parent_number: v.nullable(DbIntegerSchema),
});
const ShowLinkSchema = v.object({ kind: NonEmptyStringSchema, ref: NonEmptyStringSchema });

function findTask(db: Database, issue: string): TaskRow {
  const task = v.parse(
    v.nullable(TaskRowSchema),
    db
      .query("SELECT id, linear_issue_id, title, status FROM tasks WHERE linear_issue_id = $issue")
      .get({ issue }),
  );
  if (!task) throw new Error(`Task not found: ${issue}`);
  return task;
}

function inferTask(db: Database, checkoutId: string | null): TaskRow {
  if (!checkoutId) throw new Error("Cannot infer a task without a current checkout");
  const tasks = v.parse(
    v.array(TaskRowSchema),
    db
      .query(
        `SELECT DISTINCT t.id, t.linear_issue_id, t.title, t.status
           FROM tasks t
           JOIN executions e ON e.task_id = t.id
          WHERE e.checkout_id = $checkoutId AND e.status = 'active'`,
      )
      .all({ checkoutId }),
  );
  if (tasks.length !== 1)
    throw new Error(`Cannot infer a task: the current checkout has ${tasks.length} active tasks`);
  return tasks[0]!;
}

function inferOptionalTask(db: Database, checkoutId: string | null): TaskRow | null {
  if (!checkoutId) return null;
  const tasks = v.parse(
    v.array(TaskRowSchema),
    db
      .query(
        `SELECT DISTINCT t.id, t.linear_issue_id, t.title, t.status
           FROM tasks t
           JOIN executions e ON e.task_id = t.id
          WHERE e.checkout_id = $checkoutId AND e.status = 'active'`,
      )
      .all({ checkoutId }),
  );
  return tasks.length === 1 ? tasks[0]! : null;
}

export function addTask(
  db: Database,
  issue: string,
  title?: string,
): { issue: string; status: TaskRow["status"] } {
  const existing = v.parse(
    v.nullable(TaskRowSchema),
    db
      .query("SELECT id, linear_issue_id, title, status FROM tasks WHERE linear_issue_id = $issue")
      .get({ issue }),
  );
  if (!existing) {
    db.query(
      "INSERT INTO tasks (id, linear_issue_id, title, status) VALUES ($id, $issue, $title, 'open')",
    ).run({ id: newId(), issue, title: title ?? null });
    return { issue, status: "open" };
  }
  if (title !== undefined) {
    db.query("UPDATE tasks SET title = $title, updated_at = CURRENT_TIMESTAMP WHERE id = $id").run({
      id: existing.id,
      title,
    });
  }
  return { issue, status: existing.status };
}

export function startTask(
  db: Database,
  current: CurrentContext,
  issue: string,
  options: { title?: string; worktree?: string },
): { executionId: string; reopened: boolean; checkoutId: string | null } {
  const checkout = options.worktree ? discoverCheckout(options.worktree, true) : current.checkout;
  let checkoutId: string | null = null;
  let executionId = "";
  let reopened = false;

  db.transaction(() => {
    checkoutId = ensureCheckout(db, checkout);
    touchRunCheckout(db, current.sessionRunId, checkoutId);
    const existing = v.parse(
      v.nullable(v.object({ id: NonEmptyStringSchema, status: TaskStatusSchema })),
      db.query("SELECT id, status FROM tasks WHERE linear_issue_id = $issue").get({ issue }),
    );
    let taskId: string;
    if (existing) {
      taskId = existing.id;
      reopened = existing.status === "done" || existing.status === "cancelled";
      db.query(
        `UPDATE tasks
            SET status = 'active', title = COALESCE($title, title), updated_at = CURRENT_TIMESTAMP
          WHERE id = $id`,
      ).run({ id: taskId, title: options.title ?? null });
    } else {
      taskId = newId();
      db.query(
        "INSERT INTO tasks (id, linear_issue_id, title, status) VALUES ($id, $issue, $title, 'active')",
      ).run({
        id: taskId,
        issue,
        title: options.title ?? null,
      });
    }

    const execution = v.parse(
      v.nullable(IdRowSchema),
      db
        .query(
          `SELECT id FROM executions
            WHERE task_id = $taskId AND cli_session_id = $sessionId
              AND checkout_id IS $checkoutId AND status = 'active'
            LIMIT 1`,
        )
        .get({ taskId, sessionId: current.cliSessionId, checkoutId }),
    );
    if (execution) {
      executionId = execution.id;
      db.query("UPDATE executions SET session_run_id = $runId WHERE id = $id").run({
        id: executionId,
        runId: current.sessionRunId,
      });
    } else {
      executionId = newId();
      db.query(
        `INSERT INTO executions
          (id, task_id, cli_session_id, session_run_id, checkout_id)
         VALUES ($id, $taskId, $sessionId, $runId, $checkoutId)`,
      ).run({
        id: executionId,
        taskId,
        sessionId: current.cliSessionId,
        runId: current.sessionRunId,
        checkoutId,
      });
    }
  }).immediate();

  return { executionId, reopened, checkoutId };
}

export function doneTask(
  db: Database,
  current: CurrentContext,
  issue?: string,
): { issue: string; finished: number; abandoned: number } {
  const task = issue ? findTask(db, issue) : inferTask(db, current.checkoutId);
  let finished = 0;
  let abandoned = 0;
  db.transaction(() => {
    db.query("UPDATE tasks SET status = 'done', updated_at = CURRENT_TIMESTAMP WHERE id = $id").run(
      { id: task.id },
    );
    finished = db
      .query(
        `UPDATE executions SET status = 'finished', finished_at = CURRENT_TIMESTAMP
          WHERE task_id = $taskId AND cli_session_id = $sessionId AND status = 'active'`,
      )
      .run({ taskId: task.id, sessionId: current.cliSessionId }).changes;
    abandoned = db
      .query(
        `UPDATE executions SET status = 'abandoned', finished_at = CURRENT_TIMESTAMP
          WHERE task_id = $taskId AND cli_session_id <> $sessionId AND status = 'active'`,
      )
      .run({ taskId: task.id, sessionId: current.cliSessionId }).changes;
  }).immediate();
  return { issue: task.linear_issue_id, finished, abandoned };
}

export function cancelTask(
  db: Database,
  current: CurrentContext | null,
  issue?: string,
): { issue: string; abandoned: number } {
  const task = issue ? findTask(db, issue) : inferTask(db, current?.checkoutId ?? null);
  let abandoned = 0;
  db.transaction(() => {
    db.query(
      "UPDATE tasks SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = $id",
    ).run({ id: task.id });
    abandoned = db
      .query(
        `UPDATE executions SET status = 'abandoned', finished_at = CURRENT_TIMESTAMP
          WHERE task_id = $taskId AND status = 'active'`,
      )
      .run({ taskId: task.id }).changes;
  }).immediate();
  return { issue: task.linear_issue_id, abandoned };
}

function runGh(args: string[], cwd?: string): string {
  const result = Bun.spawnSync(["gh", ...args], {
    cwd,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim() || "gh failed");
  return result.stdout.toString().trim();
}

function loadPullRequest(repo: string, number: number, cwd?: string): PullRequestData {
  const raw = runGh(
    ["pr", "view", String(number), "--repo", repo, "--json", "number,url,headRefName,baseRefName"],
    cwd,
  );
  try {
    const value = v.parse(PullRequestSchema, JSON.parse(raw));
    if (value.number !== number) throw new Error();
    return value;
  } catch {
    throw new Error(`Invalid pull request data: ${repo}#${number}`);
  }
}

function upsertPullRequest(
  db: Database,
  repo: string,
  pr: PullRequestData,
  parentId: string | null | undefined,
): string {
  const existing = v.parse(
    v.nullable(IdRowSchema),
    db
      .query("SELECT id FROM pull_requests WHERE repo = $repo AND number = $number")
      .get({ repo, number: pr.number }),
  );
  const id = existing?.id ?? newId();
  if (existing) {
    const params = { id, url: pr.url, head: pr.headRefName, base: pr.baseRefName };
    if (parentId === undefined) {
      db.query(
        `UPDATE pull_requests
            SET url = $url, head_branch = $head, base_branch = $base
          WHERE id = $id`,
      ).run(params);
    } else {
      db.query(
        `UPDATE pull_requests
            SET url = $url, head_branch = $head, base_branch = $base,
                parent_pr_id = $parentId
          WHERE id = $id`,
      ).run({ ...params, parentId });
    }
  } else {
    db.query(
      `INSERT INTO pull_requests (id, repo, number, url, head_branch, base_branch, parent_pr_id)
       VALUES ($id, $repo, $number, $url, $head, $base, $parentId)`,
    ).run({
      id,
      repo,
      number: pr.number,
      url: pr.url,
      head: pr.headRefName,
      base: pr.baseRefName,
      parentId: parentId ?? null,
    });
  }
  return id;
}

export function removePullRequest(
  db: Database,
  current: CurrentContext | null,
  number: number,
  issue?: string,
): { issue: string; repo: string; removed: boolean } {
  const task = issue ? findTask(db, issue) : inferTask(db, current?.checkoutId ?? null);
  const rows = v.parse(
    v.array(v.object({ id: NonEmptyStringSchema, repo: NonEmptyStringSchema })),
    db
      .query(
        `SELECT pr.id, pr.repo
           FROM task_pull_requests tpr
           JOIN pull_requests pr ON pr.id = tpr.pull_request_id
          WHERE tpr.task_id = $taskId AND pr.number = $number`,
      )
      .all({ taskId: task.id, number }),
  );
  if (rows.length === 0)
    throw new Error(`Pull request is not linked: ${task.linear_issue_id}#${number}`);
  if (rows.length > 1)
    throw new Error(`Cannot remove pull request: ${task.linear_issue_id}#${number} is ambiguous`);
  const row = rows[0]!;
  const removed =
    db
      .query(
        `DELETE FROM task_pull_requests
          WHERE task_id = $taskId AND pull_request_id = $pullRequestId`,
      )
      .run({ taskId: task.id, pullRequestId: row.id }).changes === 1;
  return { issue: task.linear_issue_id, repo: row.repo, removed };
}

export function syncPullRequests(
  db: Database,
  current: CurrentContext,
): { checkouts: number; pullRequests: number; linked: number; skipped: number } {
  const executionCheckouts = v.parse(
    v.array(v.object({ id: NonEmptyStringSchema, worktree_path: NonEmptyStringSchema })),
    db
      .query(
        `SELECT DISTINCT gc.id, gc.worktree_path
           FROM executions e
           JOIN git_checkouts gc ON gc.id = e.checkout_id
          WHERE e.cli_session_id = $sessionId AND e.status = 'active'`,
      )
      .all({ sessionId: current.cliSessionId }),
  );
  const checkoutRows = new Map(executionCheckouts.map((row) => [row.id, row]));
  if (current.checkoutId && current.checkout) {
    checkoutRows.set(current.checkoutId, {
      id: current.checkoutId,
      worktree_path: current.checkout.worktreePath,
    });
  }

  const pullRequests = new Map<string, { repo: string; pr: PullRequestData }>();
  const links: Array<{ repo: string; pr: PullRequestData; taskId: string }> = [];
  let skipped = 0;
  for (const row of checkoutRows.values()) {
    const checkout = discoverCheckout(row.worktree_path, true)!;
    const tasks = v.parse(
      v.array(IdRowSchema),
      db
        .query(
          `SELECT DISTINCT t.id
             FROM tasks t JOIN executions e ON e.task_id = t.id
            WHERE e.checkout_id = $checkoutId AND e.status = 'active'`,
        )
        .all({ checkoutId: row.id }),
    );
    const repoRaw = runGh(["repo", "view", "--json", "nameWithOwner"], checkout.worktreePath);
    let repo: string;
    try {
      repo = v.parse(RepositorySchema, JSON.parse(repoRaw)).nameWithOwner;
    } catch {
      throw new Error(`Could not resolve the repository with gh: ${checkout.worktreePath}`);
    }
    const registered = v.parse(
      v.array(v.object({ number: DbIntegerSchema })),
      db.query(`SELECT number FROM pull_requests WHERE repo = $repo`).all({ repo }),
    );
    for (const item of registered) {
      const pr = loadPullRequest(repo, item.number, checkout.worktreePath);
      pullRequests.set(`${repo}#${pr.number}`, { repo, pr });
    }
    if (!checkout.branch) {
      skipped++;
      continue;
    }
    const raw = runGh(
      [
        "pr",
        "list",
        "--repo",
        repo,
        "--head",
        checkout.branch,
        "--state",
        "open",
        "--json",
        "number,url,headRefName,baseRefName",
      ],
      checkout.worktreePath,
    );
    let prs: PullRequestData[];
    try {
      prs = v.parse(PullRequestListSchema, JSON.parse(raw));
    } catch {
      throw new Error(`Invalid pull request data: ${repo}:${checkout.branch}`);
    }
    if (prs.length === 0) {
      skipped++;
      continue;
    }
    if (prs.length > 1)
      throw new Error(`Multiple open pull requests found: ${repo}:${checkout.branch}`);
    const pr = prs[0]!;
    pullRequests.set(`${repo}#${pr.number}`, { repo, pr });
    if (tasks.length === 1) links.push({ repo, pr, taskId: tasks[0]!.id });
  }

  let linked = 0;
  db.transaction(() => {
    const ids = new Map<string, string>();
    for (const item of pullRequests.values()) {
      ids.set(
        `${item.repo}#${item.pr.number}`,
        upsertPullRequest(db, item.repo, item.pr, undefined),
      );
    }
    for (const item of links) {
      const pullRequestId = ids.get(`${item.repo}#${item.pr.number}`)!;
      linked += db
        .query(
          `INSERT INTO task_pull_requests (task_id, pull_request_id)
           VALUES ($taskId, $pullRequestId)
           ON CONFLICT DO NOTHING`,
        )
        .run({ taskId: item.taskId, pullRequestId }).changes;
    }
  }).immediate();
  return {
    checkouts: checkoutRows.size,
    pullRequests: pullRequests.size,
    linked,
    skipped,
  };
}

export function addPullRequest(
  db: Database,
  current: CurrentContext,
  number: number,
  options: { task?: string; parent?: number },
): { repo: string; warning: string | null } {
  if (!current.checkout) throw new Error("A Git checkout is required to register a pull request");
  const repoRaw = runGh(["repo", "view", "--json", "nameWithOwner"]);
  let repoValue: v.InferOutput<typeof RepositorySchema>;
  try {
    repoValue = v.parse(RepositorySchema, JSON.parse(repoRaw));
  } catch {
    throw new Error("Could not resolve the repository with gh");
  }
  const repo = repoValue.nameWithOwner;
  const child = loadPullRequest(repo, number);
  if (options.parent === number) throw new Error("A pull request cannot be its own parent");
  const parent = options.parent === undefined ? null : loadPullRequest(repo, options.parent);
  const task = options.task
    ? findTask(db, options.task)
    : inferOptionalTask(db, current.checkoutId);
  const warning =
    parent && child.baseRefName !== parent.headRefName
      ? `Stack branch mismatch: child base=${child.baseRefName}, parent head=${parent.headRefName}`
      : null;

  db.transaction(() => {
    const parentId = parent ? upsertPullRequest(db, repo, parent, null) : null;
    const childId = upsertPullRequest(db, repo, child, parentId);
    if (task) {
      db.query(
        `INSERT INTO task_pull_requests (task_id, pull_request_id)
         VALUES ($taskId, $pullRequestId)
         ON CONFLICT DO NOTHING`,
      ).run({ taskId: task.id, pullRequestId: childId });
    }
  }).immediate();

  return { repo, warning };
}

export function addWorkpadLink(
  db: Database,
  current: CurrentContext,
  path: string,
  issue?: string,
): { issue: string | null; ref: string } {
  if (!current.checkoutId) throw new Error("A Git checkout is required to register a workpad");
  const ref = existsSync(path) ? realpathSync(path) : path;
  const task = issue ? findTask(db, issue) : inferOptionalTask(db, current.checkoutId);
  db.query(
    `INSERT INTO task_links (id, task_id, checkout_id, kind, ref)
     VALUES ($id, $taskId, $checkoutId, 'workpad', $ref)
     ON CONFLICT DO NOTHING`,
  ).run({ id: newId(), taskId: task?.id ?? null, checkoutId: current.checkoutId, ref });
  return { issue: task?.linear_issue_id ?? null, ref };
}

export function removeWorkpadLink(
  db: Database,
  current: CurrentContext | null,
  path: string,
  issue?: string,
): { issue: string | null; ref: string } {
  if (!current?.checkoutId) throw new Error("A Git checkout is required to remove a workpad");
  const ref = existsSync(path) ? realpathSync(path) : path;
  const task = issue ? findTask(db, issue) : inferOptionalTask(db, current.checkoutId);
  const removed = db
    .query(
      `DELETE FROM task_links
        WHERE task_id IS $taskId AND checkout_id = $checkoutId
          AND kind = 'workpad' AND ref = $ref`,
    )
    .run({ taskId: task?.id ?? null, checkoutId: current.checkoutId, ref }).changes;
  if (removed === 0)
    throw new Error(`Workpad is not linked: ${task?.linear_issue_id ?? "unassigned"}:${ref}`);
  return { issue: task?.linear_issue_id ?? null, ref };
}

type ShowTask = TaskRow & {
  executions: v.InferOutput<typeof ShowExecutionSchema>[];
  pullRequests: v.InferOutput<typeof ShowPullRequestSchema>[];
  links: v.InferOutput<typeof ShowLinkSchema>[];
};

export function show(
  db: Database,
  current: CurrentContext | null,
  options: { task?: string; worktree?: string },
): string {
  let rows: TaskRow[];
  if (options.task) {
    rows = [findTask(db, options.task)];
  } else if (options.worktree) {
    const checkout = discoverCheckout(options.worktree, true)!;
    rows = v.parse(
      v.array(TaskRowSchema),
      db
        .query(
          `SELECT DISTINCT t.id, t.linear_issue_id, t.title, t.status
             FROM tasks t JOIN executions e ON e.task_id = t.id
             JOIN git_checkouts gc ON gc.id = e.checkout_id
            WHERE gc.repo_root = $repoRoot AND gc.worktree_path = $worktreePath`,
        )
        .all(checkout),
    );
  } else {
    if (!current) throw new Error("Could not resolve the current context");
    rows = v.parse(
      v.array(TaskRowSchema),
      db
        .query(
          `SELECT DISTINCT t.id, t.linear_issue_id, t.title, t.status
             FROM tasks t JOIN executions e ON e.task_id = t.id
            WHERE e.cli_session_id = $sessionId`,
        )
        .all({ sessionId: current.cliSessionId }),
    );
  }

  if (rows.length === 0) return "No related tasks";
  const tasks: ShowTask[] = rows.map((task) => ({
    id: task.id,
    linear_issue_id: task.linear_issue_id,
    title: task.title,
    status: task.status,
    executions: v.parse(
      v.array(ShowExecutionSchema),
      db
        .query(
          `SELECT e.status, cs.cli, cs.external_session_id, gc.worktree_path, gc.branch
             FROM executions e JOIN cli_sessions cs ON cs.id = e.cli_session_id
             LEFT JOIN git_checkouts gc ON gc.id = e.checkout_id
            WHERE e.task_id = $taskId ORDER BY e.started_at`,
        )
        .all({ taskId: task.id }),
    ),
    pullRequests: v.parse(
      v.array(ShowPullRequestSchema),
      db
        .query(
          `SELECT pr.repo, pr.number, pr.url, pr.head_branch, pr.base_branch,
                  parent.number AS parent_number
             FROM task_pull_requests tpr JOIN pull_requests pr ON pr.id = tpr.pull_request_id
             LEFT JOIN pull_requests parent ON parent.id = pr.parent_pr_id
            WHERE tpr.task_id = $taskId ORDER BY pr.number`,
        )
        .all({ taskId: task.id }),
    ),
    links: v.parse(
      v.array(ShowLinkSchema),
      db
        .query("SELECT kind, ref FROM task_links WHERE task_id = $taskId ORDER BY created_at")
        .all({ taskId: task.id }),
    ),
  }));

  return tasks
    .map((task) => {
      const lines = [
        `Task ${task.linear_issue_id} [${task.status}]${task.title ? ` ${task.title}` : ""}`,
      ];
      for (const execution of task.executions) {
        const checkout = execution.worktree_path
          ? ` ${execution.worktree_path}${execution.branch ? ` (${execution.branch})` : ""}`
          : "";
        lines.push(
          `  Execution ${execution.status}: ${execution.cli}:${execution.external_session_id}${checkout}`,
        );
      }
      for (const pr of task.pullRequests) {
        lines.push(
          `  PR ${pr.repo}#${pr.number}${pr.parent_number ? ` parent=#${pr.parent_number}` : ""} ${pr.url ?? ""}`.trimEnd(),
        );
      }
      for (const link of task.links) lines.push(`  ${link.kind}: ${link.ref}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

export function findRunTerminal(db: Database, target: string): string {
  const rows = v.parse(
    v.array(v.object({ iterm_session_id: NonEmptyStringSchema, session_id: NonEmptyStringSchema })),
    db
      .query(
        `SELECT DISTINCT sr.iterm_session_id, cs.id AS session_id
           FROM session_runs sr JOIN cli_sessions cs ON cs.id = sr.cli_session_id
          WHERE sr.ended_at IS NULL AND sr.iterm_session_id IS NOT NULL
            AND (sr.id = $target OR cs.external_session_id = $target)
          ORDER BY sr.last_seen_at DESC`,
      )
      .all({ target }),
  );
  if (new Set(rows.map((row) => row.session_id)).size > 1)
    throw new Error(`Session ID is ambiguous: ${target}`);
  if (!rows[0]) throw new Error(`No active terminal found for session: ${target}`);
  return rows[0].iterm_session_id.split(":").at(-1)!;
}
