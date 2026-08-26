import type { SessionLineage, ShowTask } from "./api.ts";
import { DEFAULT_FIELDS, RESOURCE_FIELDS, type ResourceName } from "./resources.ts";

function terminalText(value: unknown): string {
  return String(value ?? "-").replace(/\p{Cc}/gu, " ");
}

function projectRows(
  resource: ResourceName,
  rows: Array<Record<string, unknown>>,
  fields: string[],
): Array<Record<string, unknown>> {
  const available = new Set(RESOURCE_FIELDS[resource]);
  for (const field of fields) {
    if (!available.has(field)) throw new Error(`Unknown JSON field for ${resource}: ${field}`);
  }
  return rows.map((row) => Object.fromEntries(fields.map((field) => [field, row[field] ?? null])));
}

export function renderResource(
  resource: ResourceName,
  rows: Array<Record<string, unknown>>,
  jsonFields?: string,
  jqExpression?: string,
  nonCurrentCount?: number,
): string {
  if (jsonFields === undefined) {
    if (jqExpression !== undefined) throw new Error("--jq requires --json");
    const footer = nonCurrentCount ? `+ ${nonCurrentCount} non-current` : "";
    if (rows.length === 0) {
      const base = nonCurrentCount ? `No current ${resource}` : `No ${resource}`;
      return footer ? `${base}\n${footer}` : base;
    }
    let body: string;
    if (resource === "tasks") {
      body = ["open", "active", "done", "cancelled"]
        .map((status) => {
          const tasks = rows.filter((row) => row.status === status);
          if (tasks.length === 0) return null;
          return [
            `${status}:`,
            ...tasks.map(
              (task) =>
                `  ${terminalText(task.linearIssueId)}${task.title ? ` ${terminalText(task.title)}` : ""} devices=${terminalText(task.deviceNames)} updated=${terminalText(task.updatedAt)}`,
            ),
          ].join("\n");
        })
        .filter((group) => group !== null)
        .join("\n\n");
    } else {
      body = projectRows(resource, rows, DEFAULT_FIELDS[resource])
        .map((row) =>
          Object.entries(row)
            .map(([key, value]) => `${key}=${terminalText(value)}`)
            .join(" "),
        )
        .join("\n");
    }
    return footer ? `${body}\n\n${footer}` : body;
  }

  const fields = jsonFields
    .split(",")
    .map((field) => field.trim())
    .filter(Boolean);
  if (fields.length === 0) throw new Error("--json requires at least one field");
  const projected = projectRows(resource, rows, fields);
  if (jqExpression === undefined) return JSON.stringify(projected, null, 2);
  const json = JSON.stringify(projected);
  const result = (() => {
    try {
      return Bun.spawnSync(["jq", "-r", jqExpression], {
        stdin: new TextEncoder().encode(json),
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch {
      return null;
    }
  })();
  if (!result) throw new Error("jq is required for --jq");
  if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim() || "jq failed");
  return result.stdout.toString().trimEnd();
}

function appendSessionChildren(
  lines: string[],
  children: SessionLineage["session"]["children"],
  prefix: string,
): void {
  for (const [index, child] of children.entries()) {
    const last = index === children.length - 1;
    lines.push(
      `${prefix}${last ? "└─" : "├─"} ${terminalText(child.cli)}:${terminalText(child.externalSessionId)} [${terminalText(child.status)}]`,
    );
    appendSessionChildren(lines, child.children, `${prefix}${last ? "   " : "│  "}`);
  }
}

export function renderSessionLineage(lineage: SessionLineage): string {
  const path = [...lineage.ancestors, lineage.session];
  const lines = path.map(
    (session, index) =>
      `${index === 0 ? "" : `${"   ".repeat(index - 1)}└─ `}${terminalText(session.cli)}:${terminalText(session.externalSessionId)} [${terminalText(session.status)}]`,
  );
  appendSessionChildren(lines, lineage.session.children, "   ".repeat(lineage.ancestors.length));
  return lines.join("\n");
}

export function renderShow(tasks: ShowTask[]): string {
  if (tasks.length === 0) return "No related tasks";
  return tasks
    .map((task) => {
      const lines = [
        `Task ${terminalText(task.linearIssueId)} [${terminalText(task.status)}]${task.title ? ` ${terminalText(task.title)}` : ""} devices=${terminalText(task.deviceNames)}`,
      ];
      for (const execution of task.executions) {
        const checkout = execution.worktreePath
          ? ` ${terminalText(execution.worktreePath)}${execution.branch ? ` (${terminalText(execution.branch)})` : ""}`
          : "";
        lines.push(
          `  Execution ${terminalText(execution.status)}: ${terminalText(execution.cli)}:${terminalText(execution.externalSessionId)} device=${terminalText(execution.deviceName)}${checkout}`,
        );
      }
      for (const pullRequest of task.pullRequests) {
        lines.push(
          `  PR ${terminalText(pullRequest.repo)}#${terminalText(pullRequest.number)}${pullRequest.parentNumber ? ` parent=#${terminalText(pullRequest.parentNumber)}` : ""} devices=${terminalText(pullRequest.deviceNames)} ${terminalText(pullRequest.url)}`,
        );
      }
      for (const link of task.links)
        lines.push(
          `  ${terminalText(link.kind)}: ${terminalText(link.ref)} device=${terminalText(link.deviceName)}`,
        );
      return lines.join("\n");
    })
    .join("\n\n");
}
