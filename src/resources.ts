export type ResourceName =
  | "tasks"
  | "sessions"
  | "runs"
  | "checkouts"
  | "executions"
  | "links"
  | "prs"
  | "branches"
  | "terminals"
  | "repos";

export const RESOURCE_FIELDS: Record<ResourceName, string[]> = {
  tasks: ["linearIssueId", "title", "status", "createdAt", "updatedAt"],
  sessions: [
    "id",
    "session",
    "cli",
    "externalSessionId",
    "initialPrompt",
    "status",
    "createdAt",
    "updatedAt",
  ],
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
    "linearIssueId",
    "session",
    "runId",
    "checkoutId",
    "status",
    "startedAt",
    "finishedAt",
    "worktreePath",
  ],
  links: ["id", "linearIssueId", "repoRoot", "worktreePath", "kind", "ref", "createdAt"],
  prs: [
    "repo",
    "number",
    "url",
    "headBranch",
    "baseBranch",
    "state",
    "parentNumber",
    "linearIssueId",
    "createdAt",
  ],
  branches: ["repoRoot", "branch", "worktreePath"],
  terminals: ["itermSessionId", "terminalId", "runId", "session", "status", "pane", "lastSeenAt"],
  repos: ["repoRoot", "enabled", "worktreeCount", "updatedAt"],
};

export const DEFAULT_FIELDS: Record<ResourceName, string[]> = {
  tasks: ["linearIssueId", "status", "title", "updatedAt"],
  sessions: ["session", "id", "status", "createdAt"],
  runs: ["id", "session", "status", "itermSessionId", "lastSeenAt"],
  checkouts: ["repoRoot", "worktreePath", "branch"],
  executions: ["id", "linearIssueId", "session", "status", "worktreePath"],
  links: ["linearIssueId", "kind", "ref", "worktreePath"],
  prs: ["repo", "number", "state", "linearIssueId", "headBranch", "baseBranch", "url"],
  branches: ["repoRoot", "branch", "worktreePath"],
  terminals: ["terminalId", "session", "runId", "status", "pane", "lastSeenAt"],
  repos: ["repoRoot", "enabled", "worktreeCount", "updatedAt"],
};

export function isCurrentResource(resource: ResourceName, row: Record<string, unknown>): boolean {
  if (resource === "tasks") return row.status === "open" || row.status === "active";
  if (resource === "prs") return row.state === "open";
  if (resource === "sessions" || resource === "runs" || resource === "terminals")
    return row.status === "active";
  if (resource === "executions") return row.status === "active";
  return true;
}
