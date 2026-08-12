import { DEFAULT_FIELDS, RESOURCE_FIELDS, type ResourceName } from "./resources.ts";

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
): string {
  if (jsonFields === undefined) {
    if (jqExpression !== undefined) throw new Error("--jq requires --json");
    if (rows.length === 0) return `No ${resource}`;
    if (resource === "tasks") {
      return ["active", "open", "done", "cancelled"]
        .map((status) => {
          const tasks = rows.filter((row) => row.status === status);
          if (tasks.length === 0) return null;
          return [
            `${status}:`,
            ...tasks.map(
              (task) =>
                `  ${task.linearIssueId}${task.title ? ` ${task.title}` : ""} updated=${task.updatedAt}`,
            ),
          ].join("\n");
        })
        .filter((group) => group !== null)
        .join("\n\n");
    }
    return projectRows(resource, rows, DEFAULT_FIELDS[resource])
      .map((row) =>
        Object.entries(row)
          .map(([key, value]) => `${key}=${value ?? "-"}`)
          .join(" "),
      )
      .join("\n");
  }

  const fields = jsonFields
    .split(",")
    .map((field) => field.trim())
    .filter(Boolean);
  if (fields.length === 0) throw new Error("--json requires at least one field");
  const json = JSON.stringify(projectRows(resource, rows, fields));
  if (jqExpression === undefined) return JSON.stringify(JSON.parse(json), null, 2);
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
