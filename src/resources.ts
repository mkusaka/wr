import type { Database } from "bun:sqlite";

export type ResourceName =
  | "tasks"
  | "sessions"
  | "runs"
  | "checkouts"
  | "executions"
  | "links"
  | "prs"
  | "branches"
  | "terminals";

export type ResourceFilters = {
  task?: string;
  session?: string;
  run?: string;
  checkout?: string;
  execution?: string;
  link?: string;
  terminal?: string;
  repoRoot?: string;
  worktreePath?: string;
  branch?: string;
  pullRequest?: number;
  status?: string;
  kind?: string;
};

export const RESOURCE_FIELDS: Record<ResourceName, string[]> = {
  tasks: ["id", "linearIssueId", "parentTaskId", "title", "status", "createdAt", "updatedAt"],
  sessions: ["id", "session", "cli", "externalSessionId", "parentSessionId", "createdAt"],
  runs: [
    "id",
    "sessionId",
    "session",
    "itermSessionId",
    "startedCwd",
    "source",
    "status",
    "startedAt",
    "lastSeenAt",
    "endedAt",
    "endReason",
    "pane",
  ],
  checkouts: ["id", "repoRoot", "worktreePath", "branch", "createdAt"],
  executions: [
    "id",
    "taskId",
    "linearIssueId",
    "sessionId",
    "session",
    "runId",
    "checkoutId",
    "role",
    "status",
    "startedAt",
    "finishedAt",
    "worktreePath",
  ],
  links: ["id", "taskId", "linearIssueId", "kind", "ref", "metadata", "createdAt"],
  prs: [
    "id",
    "repo",
    "number",
    "url",
    "headBranch",
    "baseBranch",
    "parentPrId",
    "parentNumber",
    "createdAt",
    "linearIssueId",
  ],
  branches: ["repoRoot", "branch", "worktreePath"],
  terminals: [
    "itermSessionId",
    "terminalId",
    "runId",
    "sessionId",
    "session",
    "status",
    "pane",
    "lastSeenAt",
  ],
};

export const DEFAULT_FIELDS: Record<ResourceName, string[]> = {
  tasks: ["linearIssueId", "status", "title", "updatedAt"],
  sessions: ["session", "id", "createdAt"],
  runs: ["id", "session", "status", "itermSessionId", "lastSeenAt"],
  checkouts: ["repoRoot", "worktreePath", "branch"],
  executions: ["id", "linearIssueId", "session", "status", "worktreePath"],
  links: ["linearIssueId", "kind", "ref"],
  prs: ["repo", "number", "linearIssueId", "headBranch", "baseBranch", "url"],
  branches: ["repoRoot", "branch", "worktreePath"],
  terminals: ["terminalId", "session", "runId", "status", "pane", "lastSeenAt"],
};

const RELATIONSHIPS = `WITH relationships AS (
  SELECT
    t.id AS taskId, t.linear_issue_id AS linearIssueId, t.parent_task_id AS parentTaskId,
    t.title AS taskTitle, t.status AS taskStatus, t.created_at AS taskCreatedAt,
    t.updated_at AS taskUpdatedAt,
    cs.id AS sessionId, cs.cli AS cli, cs.external_session_id AS externalSessionId,
    cs.parent_session_id AS parentSessionId, cs.created_at AS sessionCreatedAt,
    cs.cli || ':' || cs.external_session_id AS session,
    sr.id AS runId, sr.iterm_session_id AS itermSessionId, sr.started_cwd AS startedCwd,
    sr.source AS runSource, sr.started_at AS runStartedAt, sr.last_seen_at AS lastSeenAt,
    sr.ended_at AS endedAt, sr.end_reason AS endReason,
    CASE WHEN sr.ended_at IS NULL THEN 'active' ELSE 'ended' END AS runStatus,
    e.id AS executionId, e.checkout_id AS executionCheckoutId, e.role AS executionRole,
    e.status AS executionStatus, e.started_at AS executionStartedAt,
    e.finished_at AS executionFinishedAt,
    gc.id AS checkoutId, gc.repo_root AS repoRoot, gc.worktree_path AS worktreePath,
    gc.branch AS branch, gc.created_at AS checkoutCreatedAt,
    pr.id AS prId, pr.repo AS prRepo, pr.number AS prNumber, pr.url AS prUrl,
    pr.head_branch AS headBranch, pr.base_branch AS baseBranch,
    pr.parent_pr_id AS parentPrId, parent.number AS parentNumber, pr.created_at AS prCreatedAt,
    tl.id AS linkId, tl.kind AS linkKind, tl.ref AS linkRef,
    tl.metadata_json AS linkMetadata, tl.created_at AS linkCreatedAt
  FROM cli_sessions cs
  LEFT JOIN session_runs sr ON sr.cli_session_id = cs.id
  LEFT JOIN executions e ON e.session_run_id = sr.id
  LEFT JOIN tasks t ON t.id = e.task_id
  LEFT JOIN git_checkouts gc ON gc.id = e.checkout_id
  LEFT JOIN task_pull_requests tpr ON tpr.task_id = t.id
  LEFT JOIN pull_requests pr ON pr.id = tpr.pull_request_id
  LEFT JOIN pull_requests parent ON parent.id = pr.parent_pr_id
  LEFT JOIN task_links tl ON tl.task_id = t.id
)`;

const FILTERS = `($task IS NULL OR linearIssueId = $task)
  AND ($session IS NULL OR externalSessionId = $session)
  AND ($run IS NULL OR runId = $run)
  AND ($checkout IS NULL OR checkoutId = $checkout)
  AND ($execution IS NULL OR executionId = $execution)
  AND ($link IS NULL OR linkId = $link)
  AND ($terminal IS NULL OR itermSessionId = $terminal OR itermSessionId LIKE '%:' || $terminal)
  AND ($repoRoot IS NULL OR repoRoot = $repoRoot)
  AND ($worktreePath IS NULL OR worktreePath = $worktreePath)
  AND ($branch IS NULL OR branch = $branch)
  AND ($pullRequest IS NULL OR prNumber = $pullRequest)`;

function baseQuery(resource: ResourceName): string {
  switch (resource) {
    case "tasks":
      return `SELECT id, linear_issue_id AS linearIssueId, parent_task_id AS parentTaskId,
                     title, status, created_at AS createdAt, updated_at AS updatedAt
                FROM tasks ORDER BY updated_at DESC, linear_issue_id`;
    case "sessions":
      return `SELECT id, cli, external_session_id AS externalSessionId,
                     parent_session_id AS parentSessionId, created_at AS createdAt,
                     cli || ':' || external_session_id AS session
                FROM cli_sessions ORDER BY created_at DESC`;
    case "runs":
      return `SELECT sr.id, sr.cli_session_id AS sessionId,
                     cs.cli || ':' || cs.external_session_id AS session,
                     sr.iterm_session_id AS itermSessionId, sr.started_cwd AS startedCwd,
                     sr.source, CASE WHEN sr.ended_at IS NULL THEN 'active' ELSE 'ended' END AS status,
                     sr.started_at AS startedAt, sr.last_seen_at AS lastSeenAt,
                     sr.ended_at AS endedAt, sr.end_reason AS endReason
                FROM session_runs sr JOIN cli_sessions cs ON cs.id = sr.cli_session_id
               ORDER BY sr.last_seen_at DESC`;
    case "checkouts":
      return `SELECT id, repo_root AS repoRoot, worktree_path AS worktreePath,
                     branch, created_at AS createdAt
                FROM git_checkouts ORDER BY created_at DESC`;
    case "executions":
      return `SELECT e.id, e.task_id AS taskId, t.linear_issue_id AS linearIssueId,
                     e.cli_session_id AS sessionId,
                     cs.cli || ':' || cs.external_session_id AS session,
                     e.session_run_id AS runId, e.checkout_id AS checkoutId,
                     e.role, e.status, e.started_at AS startedAt, e.finished_at AS finishedAt,
                     gc.worktree_path AS worktreePath
                FROM executions e JOIN tasks t ON t.id = e.task_id
                JOIN cli_sessions cs ON cs.id = e.cli_session_id
                LEFT JOIN git_checkouts gc ON gc.id = e.checkout_id
               ORDER BY e.started_at DESC`;
    case "links":
      return `SELECT tl.id, tl.task_id AS taskId, t.linear_issue_id AS linearIssueId,
                     tl.kind, tl.ref, tl.metadata_json AS metadata, tl.created_at AS createdAt
                FROM task_links tl JOIN tasks t ON t.id = tl.task_id
               ORDER BY tl.created_at DESC`;
    case "prs":
      return `SELECT pr.id, pr.repo, pr.number, pr.url, pr.head_branch AS headBranch,
                     pr.base_branch AS baseBranch, pr.parent_pr_id AS parentPrId,
                     parent.number AS parentNumber, pr.created_at AS createdAt,
                     t.linear_issue_id AS linearIssueId
                FROM pull_requests pr
                LEFT JOIN pull_requests parent ON parent.id = pr.parent_pr_id
                LEFT JOIN task_pull_requests tpr ON tpr.pull_request_id = pr.id
                LEFT JOIN tasks t ON t.id = tpr.task_id
               ORDER BY pr.created_at DESC, pr.repo, pr.number DESC`;
    case "branches":
      return `SELECT repo_root AS repoRoot, branch, worktree_path AS worktreePath
                FROM git_checkouts WHERE branch IS NOT NULL ORDER BY repo_root, branch`;
    case "terminals":
      return `SELECT sr.iterm_session_id AS itermSessionId, sr.id AS runId,
                     sr.cli_session_id AS sessionId,
                     cs.cli || ':' || cs.external_session_id AS session,
                     CASE WHEN sr.ended_at IS NULL THEN 'active' ELSE 'ended' END AS status,
                     sr.last_seen_at AS lastSeenAt
                FROM session_runs sr JOIN cli_sessions cs ON cs.id = sr.cli_session_id
               WHERE sr.iterm_session_id IS NOT NULL ORDER BY sr.last_seen_at DESC`;
  }
}

function relatedSelect(resource: ResourceName): string {
  switch (resource) {
    case "tasks":
      return `taskId AS id, linearIssueId, parentTaskId, taskTitle AS title,
              taskStatus AS status, taskCreatedAt AS createdAt, taskUpdatedAt AS updatedAt`;
    case "sessions":
      return `sessionId AS id, cli, externalSessionId, parentSessionId,
              sessionCreatedAt AS createdAt, session`;
    case "runs":
      return `runId AS id, sessionId, session, itermSessionId, startedCwd,
              runSource AS source, runStatus AS status, runStartedAt AS startedAt,
              lastSeenAt, endedAt, endReason`;
    case "checkouts":
      return `checkoutId AS id, repoRoot, worktreePath, branch, checkoutCreatedAt AS createdAt`;
    case "executions":
      return `executionId AS id, taskId, linearIssueId, sessionId, session, runId,
              executionCheckoutId AS checkoutId, executionRole AS role,
              executionStatus AS status, executionStartedAt AS startedAt,
              executionFinishedAt AS finishedAt, worktreePath`;
    case "links":
      return `linkId AS id, taskId, linearIssueId, linkKind AS kind, linkRef AS ref,
              linkMetadata AS metadata, linkCreatedAt AS createdAt`;
    case "prs":
      return `prId AS id, prRepo AS repo, prNumber AS number, prUrl AS url,
              headBranch, baseBranch, parentPrId, parentNumber, prCreatedAt AS createdAt,
              linearIssueId`;
    case "branches":
      return `repoRoot, branch, worktreePath`;
    case "terminals":
      return `itermSessionId, runId, sessionId, session, runStatus AS status, lastSeenAt`;
  }
}

function hasRelationshipFilter(filters: ResourceFilters): boolean {
  return Boolean(
    filters.task ||
    filters.session ||
    filters.run ||
    filters.checkout ||
    filters.execution ||
    filters.link ||
    filters.terminal ||
    filters.repoRoot ||
    filters.worktreePath ||
    filters.branch ||
    filters.pullRequest !== undefined,
  );
}

export function queryResource(
  db: Database,
  resource: ResourceName,
  filters: ResourceFilters,
): Array<Record<string, unknown>> {
  let rows: Array<Record<string, unknown>>;
  if (hasRelationshipFilter(filters)) {
    const select = relatedSelect(resource);
    const nonNull = select.split(",")[0]!.trim().split(" ")[0]!;
    rows = db
      .query(
        `${RELATIONSHIPS}
         SELECT DISTINCT ${select} FROM relationships
          WHERE ${FILTERS} AND ${nonNull} IS NOT NULL`,
      )
      .all({
        task: filters.task ?? null,
        session: filters.session ?? null,
        run: filters.run ?? null,
        checkout: filters.checkout ?? null,
        execution: filters.execution ?? null,
        link: filters.link ?? null,
        terminal: filters.terminal ?? null,
        repoRoot: filters.repoRoot ?? null,
        worktreePath: filters.worktreePath ?? null,
        branch: filters.branch ?? null,
        pullRequest: filters.pullRequest ?? null,
      }) as Array<Record<string, unknown>>;
  } else {
    rows = db.query(baseQuery(resource)).all() as Array<Record<string, unknown>>;
  }

  if (filters.status) rows = rows.filter((row) => row.status === filters.status);
  if (filters.kind) rows = rows.filter((row) => row.kind === filters.kind);
  if (resource === "terminals") {
    rows = rows.map((row) => ({
      ...row,
      terminalId:
        typeof row.itermSessionId === "string"
          ? row.itermSessionId.split(":").at(-1)
          : row.itermSessionId,
    }));
  }
  const orderField: Partial<Record<ResourceName, string>> = {
    tasks: "updatedAt",
    sessions: "createdAt",
    runs: "lastSeenAt",
    checkouts: "createdAt",
    executions: "startedAt",
    links: "createdAt",
    prs: "createdAt",
    terminals: "lastSeenAt",
  };
  const field = orderField[resource];
  if (field) {
    rows.sort((left, right) => String(right[field] ?? "").localeCompare(String(left[field] ?? "")));
  }
  return rows;
}
