import type { Database } from "bun:sqlite";
import { realpathSync, statSync } from "node:fs";
import * as v from "valibot";
import type { CurrentContext } from "./context.ts";
import { ensureCheckout } from "./context.ts";
import { discoverCheckout } from "./git.ts";
import { newId } from "./db.ts";
import { PullRequestSchema, RepositorySchema, type PullRequestData } from "./validation.ts";

type TaskRow = {
  id: string;
  linear_issue_id: string;
  title: string | null;
  status: string;
};

function findTask(db: Database, issue: string): TaskRow {
  const task = db
    .query("SELECT id, linear_issue_id, title, status FROM tasks WHERE linear_issue_id = $issue")
    .get({ issue }) as TaskRow | null;
  if (!task) throw new Error(`Task not found: ${issue}`);
  return task;
}

function inferTask(db: Database, checkoutId: string | null): TaskRow {
  if (!checkoutId) throw new Error("Cannot infer a task without a current checkout");
  const tasks = db
    .query(
      `SELECT DISTINCT t.id, t.linear_issue_id, t.title, t.status
         FROM tasks t
         JOIN executions e ON e.task_id = t.id
        WHERE e.checkout_id = $checkoutId AND e.status = 'active'`,
    )
    .all({ checkoutId }) as TaskRow[];
  if (tasks.length !== 1)
    throw new Error(`Cannot infer a task: the current checkout has ${tasks.length} active tasks`);
  return tasks[0]!;
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
    const existing = db
      .query("SELECT id, status FROM tasks WHERE linear_issue_id = $issue")
      .get({ issue }) as { id: string; status: string } | null;
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

    const execution = db
      .query(
        `SELECT id FROM executions
          WHERE task_id = $taskId AND cli_session_id = $sessionId
            AND checkout_id IS $checkoutId AND status = 'active'
          LIMIT 1`,
      )
      .get({ taskId, sessionId: current.cliSessionId, checkoutId }) as { id: string } | null;
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

function runGh(args: string[]): string {
  const result = Bun.spawnSync(["gh", ...args], {
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim() || "gh failed");
  return result.stdout.toString().trim();
}

function loadPullRequest(repo: string, number: number): PullRequestData {
  const raw = runGh([
    "pr",
    "view",
    String(number),
    "--repo",
    repo,
    "--json",
    "number,url,headRefName,baseRefName",
  ]);
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
  parentId: string | null,
): string {
  const existing = db
    .query("SELECT id FROM pull_requests WHERE repo = $repo AND number = $number")
    .get({ repo, number: pr.number }) as { id: string } | null;
  const id = existing?.id ?? newId();
  if (existing) {
    db.query(
      `UPDATE pull_requests
          SET url = $url, head_branch = $head, base_branch = $base, parent_pr_id = $parentId
        WHERE id = $id`,
    ).run({ id, url: pr.url, head: pr.headRefName, base: pr.baseRefName, parentId });
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
      parentId,
    });
  }
  return id;
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
  const task = options.task ? findTask(db, options.task) : inferTask(db, current.checkoutId);
  const warning =
    parent && child.baseRefName !== parent.headRefName
      ? `Stack branch mismatch: child base=${child.baseRefName}, parent head=${parent.headRefName}`
      : null;

  db.transaction(() => {
    const parentId = parent ? upsertPullRequest(db, repo, parent, null) : null;
    const childId = upsertPullRequest(db, repo, child, parentId);
    db.query(
      `INSERT INTO task_pull_requests (task_id, pull_request_id, relation)
       VALUES ($taskId, $pullRequestId, 'implements')
       ON CONFLICT DO NOTHING`,
    ).run({ taskId: task.id, pullRequestId: childId });
  }).immediate();

  return { repo, warning };
}

export function addWorkpadLink(
  db: Database,
  current: CurrentContext,
  path: string,
  issue?: string,
): { issue: string; ref: string } {
  const ref = realpathSync(path);
  if (!statSync(ref).isFile()) throw new Error(`Workpad is not a file: ${path}`);
  const task = issue ? findTask(db, issue) : inferTask(db, current.checkoutId);
  db.query(
    `INSERT INTO task_links (id, task_id, kind, ref)
     VALUES ($id, $taskId, 'workpad', $ref)
     ON CONFLICT(task_id, kind, ref) DO NOTHING`,
  ).run({ id: newId(), taskId: task.id, ref });
  return { issue: task.linear_issue_id, ref };
}

type ShowTask = TaskRow & {
  executions: Array<Record<string, unknown>>;
  pullRequests: Array<Record<string, unknown>>;
  links: Array<Record<string, unknown>>;
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
    rows = db
      .query(
        `SELECT DISTINCT t.id, t.linear_issue_id, t.title, t.status
           FROM tasks t JOIN executions e ON e.task_id = t.id
           JOIN git_checkouts gc ON gc.id = e.checkout_id
          WHERE gc.repo_root = $repoRoot AND gc.worktree_path = $worktreePath`,
      )
      .all(checkout) as TaskRow[];
  } else {
    if (!current) throw new Error("Could not resolve the current context");
    rows = current.checkoutId
      ? (db
          .query(
            `SELECT DISTINCT t.id, t.linear_issue_id, t.title, t.status
               FROM tasks t JOIN executions e ON e.task_id = t.id
              WHERE e.cli_session_id = $sessionId OR e.checkout_id = $checkoutId`,
          )
          .all({ sessionId: current.cliSessionId, checkoutId: current.checkoutId }) as TaskRow[])
      : (db
          .query(
            `SELECT DISTINCT t.id, t.linear_issue_id, t.title, t.status
               FROM tasks t JOIN executions e ON e.task_id = t.id
              WHERE e.cli_session_id = $sessionId`,
          )
          .all({ sessionId: current.cliSessionId }) as TaskRow[]);
  }

  if (rows.length === 0) return "No related tasks";
  const tasks: ShowTask[] = rows.map((task) => ({
    id: task.id,
    linear_issue_id: task.linear_issue_id,
    title: task.title,
    status: task.status,
    executions: db
      .query(
        `SELECT e.status, cs.cli, cs.external_session_id, gc.worktree_path, gc.branch
           FROM executions e JOIN cli_sessions cs ON cs.id = e.cli_session_id
           LEFT JOIN session_runs sr ON sr.id = e.session_run_id
           LEFT JOIN git_checkouts gc ON gc.id = e.checkout_id
          WHERE e.task_id = $taskId ORDER BY e.started_at`,
      )
      .all({ taskId: task.id }) as Array<Record<string, unknown>>,
    pullRequests: db
      .query(
        `SELECT pr.repo, pr.number, pr.url, pr.head_branch, pr.base_branch,
                parent.number AS parent_number
           FROM task_pull_requests tpr JOIN pull_requests pr ON pr.id = tpr.pull_request_id
           LEFT JOIN pull_requests parent ON parent.id = pr.parent_pr_id
          WHERE tpr.task_id = $taskId ORDER BY pr.number`,
      )
      .all({ taskId: task.id }) as Array<Record<string, unknown>>,
    links: db
      .query("SELECT kind, ref FROM task_links WHERE task_id = $taskId ORDER BY created_at")
      .all({ taskId: task.id }) as Array<Record<string, unknown>>,
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

export function listSessions(db: Database): string {
  const rows = db
    .query(
      `SELECT sr.id, cs.cli, cs.external_session_id, sr.iterm_session_id,
              sr.started_cwd, sr.source, sr.last_seen_at,
              (julianday('now') - julianday(sr.last_seen_at)) >= 1 AS stale
         FROM session_runs sr JOIN cli_sessions cs ON cs.id = sr.cli_session_id
        WHERE sr.ended_at IS NULL ORDER BY sr.last_seen_at DESC`,
    )
    .all() as Array<Record<string, unknown>>;
  if (rows.length === 0) return "No active sessions";
  return rows
    .map(
      (row) =>
        `${row.cli}:${row.external_session_id} run=${row.id}${row.stale ? " [stale]" : ""} source=${row.source ?? "-"} terminal=${row.iterm_session_id ?? "-"} last_seen=${row.last_seen_at} cwd=${row.started_cwd ?? "-"}`,
    )
    .join("\n");
}
