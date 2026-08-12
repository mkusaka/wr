import * as v from "valibot";

export const NonEmptyStringSchema = v.pipe(v.string(), v.nonEmpty());

export const CliSchema = v.picklist(["codex", "claude"]);

export const SessionIdentitySchema = v.object({
  cli: CliSchema,
  externalSessionId: NonEmptyStringSchema,
});

export const HookPayloadSchema = v.object({
  session_id: NonEmptyStringSchema,
  cwd: NonEmptyStringSchema,
  source: v.optional(NonEmptyStringSchema),
});

export const ConfigSchema = v.object({
  repositories: v.array(NonEmptyStringSchema),
});

export const RepositorySchema = v.object({
  nameWithOwner: v.pipe(v.string(), v.regex(/^[^/]+\/[^/]+$/)),
});

export const PullRequestSchema = v.object({
  number: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  url: v.pipe(v.string(), v.url()),
  headRefName: NonEmptyStringSchema,
  baseRefName: NonEmptyStringSchema,
});

export const PullRequestListSchema = v.array(PullRequestSchema);

export const TaskStatusSchema = v.picklist(["active", "done", "cancelled"]);

export const ExecutionStatusSchema = v.picklist(["active", "finished", "abandoned"]);

export const RunStatusSchema = v.picklist(["active", "ended"]);

export const RepositoryStatusSchema = v.picklist(["active", "inactive"]);

export const ResourceNameSchema = v.picklist([
  "tasks",
  "sessions",
  "runs",
  "checkouts",
  "executions",
  "links",
  "prs",
  "branches",
  "terminals",
  "repos",
]);

export const ITermSessionListSchema = v.array(v.object({ id: NonEmptyStringSchema }));

export const PositiveIntegerSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(1));

export type SessionIdentity = v.InferOutput<typeof SessionIdentitySchema>;
export type HookPayload = v.InferOutput<typeof HookPayloadSchema>;
export type Config = v.InferOutput<typeof ConfigSchema>;
export type PullRequestData = v.InferOutput<typeof PullRequestSchema>;
