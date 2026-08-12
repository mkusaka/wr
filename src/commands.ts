import type { Database } from "bun:sqlite";
import { existsSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import * as v from "valibot";
import type { CurrentContext } from "./context.ts";
import { ensureCheckout } from "./context.ts";
import { discoverCheckout } from "./git.ts";
import { newId } from "./db.ts";
import {
  PullRequestListSchema,
  PullRequestSchema,
  RepositorySchema,
  type PullRequestData,
} from "./validation.ts";

type TaskRow = {
  id: string;
  linear_issue_id: string;
  title: string | null;
  status: string;
  updated_at?: string;
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
  const existing = db
    .query("SELECT id FROM pull_requests WHERE repo = $repo AND number = $number")
    .get({ repo, number: pr.number }) as { id: string } | null;
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
  const rows = db
    .query(
      `SELECT pr.id, pr.repo
         FROM task_pull_requests tpr
         JOIN pull_requests pr ON pr.id = tpr.pull_request_id
        WHERE tpr.task_id = $taskId AND pr.number = $number
          AND tpr.relation = 'implements'`,
    )
    .all({ taskId: task.id, number }) as Array<{ id: string; repo: string }>;
  if (rows.length === 0)
    throw new Error(`Pull request is not linked: ${task.linear_issue_id}#${number}`);
  if (rows.length > 1)
    throw new Error(`Cannot remove pull request: ${task.linear_issue_id}#${number} is ambiguous`);
  const row = rows[0]!;
  const removed =
    db
      .query(
        `DELETE FROM task_pull_requests
          WHERE task_id = $taskId AND pull_request_id = $pullRequestId
            AND relation = 'implements'`,
      )
      .run({ taskId: task.id, pullRequestId: row.id }).changes === 1;
  return { issue: task.linear_issue_id, repo: row.repo, removed };
}

export function syncPullRequests(
  db: Database,
  current: CurrentContext,
): { checkouts: number; pullRequests: number; linked: number; skipped: number } {
  const executionCheckouts = db
    .query(
      `SELECT DISTINCT gc.id, gc.worktree_path
         FROM executions e
         JOIN git_checkouts gc ON gc.id = e.checkout_id
        WHERE e.cli_session_id = $sessionId AND e.status = 'active'`,
    )
    .all({ sessionId: current.cliSessionId }) as Array<{ id: string; worktree_path: string }>;
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
    const tasks = db
      .query(
        `SELECT DISTINCT t.id
           FROM tasks t JOIN executions e ON e.task_id = t.id
          WHERE e.checkout_id = $checkoutId AND e.status = 'active'`,
      )
      .all({ checkoutId: row.id }) as Array<{ id: string }>;
    if (tasks.length === 0) {
      skipped++;
      continue;
    }
    if (tasks.length > 1)
      throw new Error(
        `${checkout.worktreePath} has ${tasks.length} active tasks; pass wr pr add explicitly`,
      );
    const taskId = tasks[0]!.id;
    const repoRaw = runGh(["repo", "view", "--json", "nameWithOwner"], checkout.worktreePath);
    let repo: string;
    try {
      repo = v.parse(RepositorySchema, JSON.parse(repoRaw)).nameWithOwner;
    } catch {
      throw new Error(`Could not resolve the repository with gh: ${checkout.worktreePath}`);
    }
    const registered = db
      .query(
        `SELECT pr.number
           FROM task_pull_requests tpr
           JOIN pull_requests pr ON pr.id = tpr.pull_request_id
          WHERE tpr.task_id = $taskId AND pr.repo = $repo`,
      )
      .all({ taskId, repo }) as Array<{ number: number }>;
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
    links.push({ repo, pr, taskId });
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
          `INSERT INTO task_pull_requests (task_id, pull_request_id, relation)
           VALUES ($taskId, $pullRequestId, 'implements')
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

export function removeWorkpadLink(
  db: Database,
  current: CurrentContext | null,
  path: string,
  issue?: string,
): { issue: string; ref: string } {
  const ref = existsSync(path) ? realpathSync(path) : resolve(path);
  const task = issue ? findTask(db, issue) : inferTask(db, current?.checkoutId ?? null);
  const removed = db
    .query("DELETE FROM task_links WHERE task_id = $taskId AND kind = 'workpad' AND ref = $ref")
    .run({ taskId: task.id, ref }).changes;
  if (removed === 0) throw new Error(`Workpad is not linked: ${task.linear_issue_id}:${ref}`);
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

export function listTasks(db: Database, options: { repoRoot?: string; status?: string }): string {
  const rows = db
    .query(
      options.repoRoot
        ? `SELECT DISTINCT t.id, t.linear_issue_id, t.title, t.status, t.updated_at
             FROM tasks t
             JOIN executions e ON e.task_id = t.id
             JOIN git_checkouts gc ON gc.id = e.checkout_id
            WHERE gc.repo_root = $repoRoot
              AND ($status IS NULL OR t.status = $status)
            ORDER BY t.updated_at DESC, t.linear_issue_id`
        : `SELECT id, linear_issue_id, title, status, updated_at
             FROM tasks
            WHERE $status IS NULL OR status = $status
            ORDER BY updated_at DESC, linear_issue_id`,
    )
    .all({ repoRoot: options.repoRoot ?? null, status: options.status ?? null }) as TaskRow[];
  if (rows.length === 0) return "No tasks";
  const groups = ["active", "open", "done", "cancelled"];
  return groups
    .map((status) => {
      const tasks = rows.filter((row) => row.status === status);
      if (tasks.length === 0) return null;
      return [
        `${status}:`,
        ...tasks.map(
          (task) =>
            `  ${task.linear_issue_id}${task.title ? ` ${task.title}` : ""} updated=${task.updated_at}`,
        ),
      ].join("\n");
    })
    .filter((group) => group !== null)
    .join("\n\n");
}

export function listPullRequests(db: Database, repoRoot?: string): string {
  const rows = db
    .query(
      repoRoot
        ? `SELECT DISTINCT pr.repo, pr.number, pr.url, pr.head_branch, pr.base_branch,
                  parent.number AS parent_number, t.linear_issue_id, t.status, pr.created_at
             FROM pull_requests pr
             JOIN task_pull_requests tpr ON tpr.pull_request_id = pr.id
             JOIN tasks t ON t.id = tpr.task_id
             JOIN executions e ON e.task_id = t.id
             JOIN git_checkouts gc ON gc.id = e.checkout_id
             LEFT JOIN pull_requests parent ON parent.id = pr.parent_pr_id
            WHERE gc.repo_root = $repoRoot
            ORDER BY pr.created_at DESC, pr.repo, pr.number DESC`
        : `SELECT pr.repo, pr.number, pr.url, pr.head_branch, pr.base_branch,
                  parent.number AS parent_number, t.linear_issue_id, t.status, pr.created_at
             FROM pull_requests pr
             JOIN task_pull_requests tpr ON tpr.pull_request_id = pr.id
             JOIN tasks t ON t.id = tpr.task_id
             LEFT JOIN pull_requests parent ON parent.id = pr.parent_pr_id
            ORDER BY pr.created_at DESC, pr.repo, pr.number DESC`,
    )
    .all({ repoRoot: repoRoot ?? null }) as Array<Record<string, unknown>>;
  if (rows.length === 0) return "No pull requests";
  return rows
    .map((row) =>
      `${row.repo}#${row.number} task=${row.linear_issue_id} [${row.status}]${row.parent_number ? ` parent=#${row.parent_number}` : ""} ${row.head_branch ?? "-"}->${row.base_branch ?? "-"} ${row.url ?? ""}`.trimEnd(),
    )
    .join("\n");
}

export function listRuns(
  db: Database,
  options: { repoRoot?: string; pullRequest?: number; branch?: string; worktreePath?: string },
  liveTerminalIds?: Set<string>,
): string {
  const filtered =
    options.pullRequest !== undefined ||
    options.branch !== undefined ||
    options.worktreePath !== undefined;
  const query = db.query(
    filtered
      ? `SELECT sr.id, cs.cli, cs.external_session_id, sr.iterm_session_id,
                  sr.started_cwd, sr.source, sr.last_seen_at, sr.ended_at, sr.end_reason,
                  (julianday('now') - julianday(sr.last_seen_at)) >= 1 AS stale,
                  group_concat(DISTINCT t.linear_issue_id) AS tasks,
                  group_concat(DISTINCT gc.worktree_path) AS worktrees
             FROM session_runs sr
             JOIN cli_sessions cs ON cs.id = sr.cli_session_id
             JOIN executions e ON e.session_run_id = sr.id
             JOIN tasks t ON t.id = e.task_id
             LEFT JOIN git_checkouts gc ON gc.id = e.checkout_id
             LEFT JOIN task_pull_requests tpr ON tpr.task_id = t.id
             LEFT JOIN pull_requests pr ON pr.id = tpr.pull_request_id
            WHERE ($pullRequest IS NULL OR pr.number = $pullRequest)
              AND ($branch IS NULL OR gc.branch = $branch)
              AND ($worktreePath IS NULL OR gc.worktree_path = $worktreePath)
              AND ($repoRoot IS NULL OR gc.repo_root = $repoRoot)
            GROUP BY sr.id
            ORDER BY sr.last_seen_at DESC`
      : `SELECT sr.id, cs.cli, cs.external_session_id, sr.iterm_session_id,
                  sr.started_cwd, sr.source, sr.last_seen_at, sr.ended_at, sr.end_reason,
                  (julianday('now') - julianday(sr.last_seen_at)) >= 1 AS stale,
                  NULL AS tasks, NULL AS worktrees
             FROM session_runs sr JOIN cli_sessions cs ON cs.id = sr.cli_session_id
            WHERE sr.ended_at IS NULL ORDER BY sr.last_seen_at DESC`,
  );
  const rows = (
    filtered
      ? query.all({
          pullRequest: options.pullRequest ?? null,
          branch: options.branch ?? null,
          worktreePath: options.worktreePath ?? null,
          repoRoot: options.repoRoot ?? null,
        })
      : query.all()
  ) as Array<Record<string, unknown>>;
  if (rows.length === 0) return filtered ? "No related runs" : "No active runs";
  return rows
    .map((row) => {
      const terminal = typeof row.iterm_session_id === "string" ? row.iterm_session_id : null;
      const terminalId = terminal?.split(":").at(-1) ?? null;
      const live =
        liveTerminalIds === undefined || terminalId === null
          ? "unknown"
          : liveTerminalIds.has(terminalId)
            ? "live"
            : "closed";
      const status = row.ended_at ? `ended:${row.end_reason ?? "unknown"}` : "active";
      return `run=${row.id} session=${row.cli}:${row.external_session_id} status=${status}${row.stale && !row.ended_at ? " [stale]" : ""} pane=${live} source=${row.source ?? "-"} terminal=${terminal ?? "-"} last_seen=${row.last_seen_at} tasks=${row.tasks ?? "-"} worktrees=${row.worktrees ?? "-"} cwd=${row.started_cwd ?? "-"}`;
    })
    .join("\n");
}

export function findRunTerminal(db: Database, target: string): string {
  const rows = db
    .query(
      `SELECT DISTINCT sr.iterm_session_id, cs.id AS session_id
         FROM session_runs sr JOIN cli_sessions cs ON cs.id = sr.cli_session_id
        WHERE sr.ended_at IS NULL AND sr.iterm_session_id IS NOT NULL
          AND (sr.id = $target OR cs.external_session_id = $target)
        ORDER BY sr.last_seen_at DESC`,
    )
    .all({ target }) as Array<{ iterm_session_id: string; session_id: string }>;
  if (new Set(rows.map((row) => row.session_id)).size > 1)
    throw new Error(`Session ID is ambiguous: ${target}`);
  if (!rows[0]) throw new Error(`No active terminal found for session: ${target}`);
  return rows[0].iterm_session_id.split(":").at(-1)!;
}
