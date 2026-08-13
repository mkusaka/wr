import type { Database } from "bun:sqlite";
import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import { useEffect, useMemo, useState } from "react";
import * as v from "valibot";
import { NonEmptyStringSchema } from "./validation.ts";

const FocusTargetRowSchema = v.object({
  id: NonEmptyStringSchema,
  session: NonEmptyStringSchema,
  itermSessionId: NonEmptyStringSchema,
  taskIds: v.string(),
  repoRoots: v.pipe(
    v.string(),
    v.transform((value) => JSON.parse(value)),
    v.array(v.string()),
  ),
  branches: v.string(),
  pullRequests: v.string(),
  prUrls: v.string(),
  startedCwd: v.nullable(v.string()),
});

export type FocusTarget = v.InferOutput<typeof FocusTargetRowSchema>;

export function queryFocusTargets(db: Database): FocusTarget[] {
  return v.parse(
    v.array(FocusTargetRowSchema),
    db
      .query(
        `SELECT sr.id, cs.cli || ':' || cs.external_session_id AS session,
                sr.iterm_session_id AS itermSessionId, sr.started_cwd AS startedCwd,
                COALESCE((
                  SELECT group_concat(value, ' ') FROM (
                    SELECT DISTINCT t.linear_issue_id AS value
                      FROM executions e JOIN tasks t ON t.id = e.task_id
                     WHERE e.session_run_id = sr.id
                  )
                ), '') AS taskIds,
                COALESCE((
                  SELECT json_group_array(value) FROM (
                    SELECT DISTINCT gc.repo_root AS value
                      FROM session_run_checkouts src
                      JOIN git_checkouts gc ON gc.id = src.checkout_id
                     WHERE src.session_run_id = sr.id
                    UNION
                    SELECT DISTINCT gc.repo_root AS value
                      FROM executions e JOIN git_checkouts gc ON gc.id = e.checkout_id
                     WHERE e.session_run_id = sr.id
                  )
                ), '[]') AS repoRoots,
                COALESCE((
                  SELECT group_concat(value, ' ') FROM (
                    SELECT DISTINCT gc.branch AS value
                      FROM session_run_checkouts src
                      JOIN git_checkouts gc ON gc.id = src.checkout_id
                     WHERE src.session_run_id = sr.id AND gc.branch IS NOT NULL
                    UNION
                    SELECT DISTINCT pr.head_branch AS value
                      FROM session_run_pull_requests srpr
                      JOIN pull_requests pr ON pr.id = srpr.pull_request_id
                     WHERE srpr.session_run_id = sr.id AND pr.head_branch IS NOT NULL
                  )
                ), '') AS branches,
                COALESCE((
                  SELECT group_concat(value, ' ') FROM (
                    SELECT DISTINCT pr.repo || '#' || pr.number AS value
                      FROM session_run_pull_requests srpr
                      JOIN pull_requests pr ON pr.id = srpr.pull_request_id
                     WHERE srpr.session_run_id = sr.id
                    UNION
                    SELECT DISTINCT pr.repo || '#' || pr.number AS value
                      FROM executions e
                      JOIN task_pull_requests tpr ON tpr.task_id = e.task_id
                      JOIN pull_requests pr ON pr.id = tpr.pull_request_id
                     WHERE e.session_run_id = sr.id
                  )
                ), '') AS pullRequests,
                COALESCE((
                  SELECT group_concat(value, ' ') FROM (
                    SELECT DISTINCT pr.url AS value
                      FROM session_run_pull_requests srpr
                      JOIN pull_requests pr ON pr.id = srpr.pull_request_id
                     WHERE srpr.session_run_id = sr.id AND pr.url IS NOT NULL
                    UNION
                    SELECT DISTINCT pr.url AS value
                      FROM executions e
                      JOIN task_pull_requests tpr ON tpr.task_id = e.task_id
                      JOIN pull_requests pr ON pr.id = tpr.pull_request_id
                     WHERE e.session_run_id = sr.id AND pr.url IS NOT NULL
                  )
                ), '') AS prUrls
           FROM session_runs sr JOIN cli_sessions cs ON cs.id = sr.cli_session_id
          WHERE sr.ended_at IS NULL AND sr.iterm_session_id IS NOT NULL
          ORDER BY sr.last_seen_at DESC`,
      )
      .all(),
  );
}

export function filterFocusTargets(targets: FocusTarget[], query: string): FocusTarget[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return targets;
  return targets.filter((target) => {
    const text = Object.values(target).flat().filter(Boolean).join(" ").toLowerCase();
    return terms.every((term) => text.includes(term));
  });
}

export function WrUi({ targets }: { targets: FocusTarget[] }) {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [status, setStatus] = useState("");
  const filtered = useMemo(() => filterFocusTargets(targets, query), [targets, query]);
  const visibleCount = Math.max(1, rows - (status ? 7 : 6));
  const visibleStart = Math.min(
    Math.max(0, selected - visibleCount + 1),
    Math.max(0, filtered.length - visibleCount),
  );
  const visibleTargets = filtered.slice(visibleStart, visibleStart + visibleCount);
  const taskWidth = columns >= 120 ? 18 : 14;
  const repoWidth = columns >= 120 ? 18 : 12;
  const branchWidth = columns >= 120 ? 42 : 28;
  const prWidth = columns >= 120 ? 18 : 10;

  useEffect(() => setSelected(0), [query]);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      exit();
      return;
    }
    if (key.escape) {
      setQuery("");
      setStatus("");
      return;
    }
    if (key.upArrow || (key.ctrl && input === "p")) {
      setSelected((index) => Math.max(0, index - 1));
      return;
    }
    if (key.downArrow || (key.ctrl && input === "n")) {
      setSelected((index) => Math.min(Math.max(0, filtered.length - 1), index + 1));
      return;
    }
    if (key.return) {
      const target = filtered[selected];
      if (!target) return;
      const terminalId = target.itermSessionId.split(":").at(-1)!;
      try {
        const result = Bun.spawnSync(["it2", "session", "focus", terminalId], {
          stdout: "pipe",
          stderr: "pipe",
        });
        setStatus(
          result.exitCode === 0
            ? `focused ${target.session}`
            : result.stderr.toString().trim() || "Could not focus the iTerm2 pane",
        );
      } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (key.backspace || key.delete) {
      setQuery((value) => value.slice(0, -1));
      setStatus("");
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setQuery((value) => value + input);
      setStatus("");
    }
  });

  return (
    <Box flexDirection="column" width="100%">
      <Text bold>wr ui — focus a session</Text>
      <Text>
        Search: <Text color="cyan">{query || "_"}</Text>
      </Text>
      <Box width="100%">
        <Box width={2} />
        <Box width={taskWidth - 2} paddingRight={1}>
          <Text dimColor>Task</Text>
        </Box>
        <Box width={repoWidth} paddingRight={1}>
          <Text dimColor>Repo</Text>
        </Box>
        <Box width={branchWidth} paddingRight={1}>
          <Text dimColor>Branch</Text>
        </Box>
        <Box width={prWidth} paddingRight={1}>
          <Text dimColor>PR</Text>
        </Box>
        <Box flexGrow={1}>
          <Text dimColor>Session</Text>
        </Box>
      </Box>
      {filtered.length === 0 ? (
        <Text dimColor>No matches</Text>
      ) : (
        visibleTargets.map((target, visibleIndex) => (
          <Box
            key={target.id}
            width="100%"
            backgroundColor={visibleStart + visibleIndex === selected ? "blue" : undefined}
          >
            <Box width={2}>
              <Text>{visibleStart + visibleIndex === selected ? "›" : " "}</Text>
            </Box>
            <Box width={taskWidth - 2} paddingRight={1}>
              <Text wrap="truncate-end">{target.taskIds.replaceAll(" ", ", ") || "-"}</Text>
            </Box>
            <Box width={repoWidth} paddingRight={1}>
              <Text wrap="truncate-end">
                {target.repoRoots.map((path) => path.split("/").at(-1)).join(", ") || "-"}
              </Text>
            </Box>
            <Box width={branchWidth} paddingRight={1}>
              <Text wrap="truncate-end">{target.branches.replaceAll(" ", ", ") || "-"}</Text>
            </Box>
            <Box width={prWidth} paddingRight={1}>
              <Text wrap="truncate-end">
                {target.pullRequests
                  .split(" ")
                  .map((pr) => (pr.includes("#") ? `#${pr.split("#").at(-1)}` : pr))
                  .join(", ") || "-"}
              </Text>
            </Box>
            <Box flexGrow={1}>
              <Text wrap="truncate-end">
                {target.session.split(":")[0]}:{target.session.split(":")[1]?.slice(0, 8)}
              </Text>
            </Box>
          </Box>
        ))
      )}
      <Text dimColor>
        {filtered.length === 0 ? "0" : `${selected + 1}/${filtered.length}`} ↑/↓ select Enter focus
        Esc clear Ctrl+C quit
      </Text>
      {status ? <Text color={status.startsWith("focused") ? "green" : "red"}>{status}</Text> : null}
    </Box>
  );
}
