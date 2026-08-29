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
  tasks: ["linearIssueId", "title", "status", "deviceNames", "createdAt", "updatedAt"],
  sessions: [
    "id",
    "session",
    "cli",
    "externalSessionId",
    "initialPrompt",
    "status",
    "deviceName",
    "createdAt",
    "updatedAt",
  ],
  runs: [
    "id",
    "sessionId",
    "parentCliSessionId",
    "session",
    "itermSessionId",
    "startedCwd",
    "source",
    "status",
    "deviceName",
    "startedAt",
    "lastSeenAt",
    "endedAt",
    "endReason",
    "pane",
  ],
  checkouts: ["id", "repoRoot", "worktreePath", "branch", "deviceName", "createdAt"],
  executions: [
    "id",
    "linearIssueId",
    "session",
    "runId",
    "checkoutId",
    "status",
    "deviceName",
    "startedAt",
    "finishedAt",
    "worktreePath",
  ],
  links: [
    "id",
    "linearIssueId",
    "repoRoot",
    "worktreePath",
    "kind",
    "ref",
    "deviceName",
    "createdAt",
  ],
  prs: [
    "repo",
    "number",
    "url",
    "headBranch",
    "baseBranch",
    "state",
    "parentNumber",
    "linearIssueId",
    "deviceNames",
    "createdAt",
  ],
  branches: ["repoRoot", "branch", "worktreePath", "deviceName"],
  terminals: [
    "itermSessionId",
    "terminalId",
    "runId",
    "session",
    "status",
    "deviceName",
    "pane",
    "lastSeenAt",
  ],
  repos: ["repoRoot", "enabled", "worktreeCount", "deviceNames", "updatedAt"],
};

export const DEFAULT_FIELDS: Record<ResourceName, string[]> = {
  tasks: ["linearIssueId", "status", "title", "deviceNames", "updatedAt"],
  sessions: ["session", "id", "status", "deviceName", "createdAt"],
  runs: ["id", "session", "status", "deviceName", "itermSessionId", "lastSeenAt"],
  checkouts: ["repoRoot", "worktreePath", "branch", "deviceName"],
  executions: ["id", "linearIssueId", "session", "status", "deviceName", "worktreePath"],
  links: ["linearIssueId", "kind", "ref", "deviceName", "worktreePath"],
  prs: [
    "repo",
    "number",
    "state",
    "linearIssueId",
    "deviceNames",
    "headBranch",
    "baseBranch",
    "url",
  ],
  branches: ["repoRoot", "branch", "worktreePath", "deviceName"],
  terminals: ["terminalId", "session", "runId", "status", "deviceName", "pane", "lastSeenAt"],
  repos: ["repoRoot", "enabled", "worktreeCount", "deviceNames", "updatedAt"],
};

export function isCurrentResource(resource: ResourceName, row: Record<string, unknown>): boolean {
  if (resource === "tasks") return row.status === "open" || row.status === "active";
  if (resource === "prs") return row.state === "open";
  if (resource === "sessions" || resource === "runs" || resource === "terminals")
    return row.status === "active";
  if (resource === "executions") return row.status === "active";
  return true;
}
