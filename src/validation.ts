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
  state: v.pipe(
    v.picklist(["OPEN", "CLOSED", "MERGED"]),
    v.transform((state) => state.toLowerCase() as "open" | "closed" | "merged"),
  ),
});

export const PullRequestStateSchema = v.picklist(["open", "closed", "merged"]);

export const PullRequestListSchema = v.array(PullRequestSchema);

export const TaskStatusSchema = v.picklist(["open", "active", "done", "cancelled"]);

export const ExecutionStatusSchema = v.picklist(["active", "finished", "abandoned"]);

export const RunStatusSchema = v.picklist(["active", "ended"]);

export const RepositoryStatusSchema = v.picklist(["active", "inactive"]);

export const ITermSessionListSchema = v.array(v.object({ id: NonEmptyStringSchema }));

export const PositiveIntegerSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(1));

export const DbIntegerSchema = v.pipe(v.number(), v.safeInteger());

export const CountRowSchema = v.object({ count: DbIntegerSchema });

export const IdRowSchema = v.object({ id: NonEmptyStringSchema });

const RecordSchema = v.record(v.string(), v.unknown());

export const RecordListSchema = v.array(RecordSchema);

export type SessionIdentity = v.InferOutput<typeof SessionIdentitySchema>;
export type HookPayload = v.InferOutput<typeof HookPayloadSchema>;
export type Config = v.InferOutput<typeof ConfigSchema>;
export type PullRequestData = v.InferOutput<typeof PullRequestSchema>;
