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
  prompt: v.optional(NonEmptyStringSchema),
});

export const ServerUrlSchema = v.pipe(
  v.string(),
  v.url(),
  v.check((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" ||
      (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    );
  }, "server URL must use HTTPS unless it targets localhost"),
);

export const ConfigSchema = v.object({
  repositories: v.array(NonEmptyStringSchema),
  serverUrl: v.optional(ServerUrlSchema),
  deviceId: v.optional(NonEmptyStringSchema),
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

export const TaskStatusSchema = v.picklist(["open", "active", "done", "cancelled"]);

export const ExecutionStatusSchema = v.picklist(["active", "finished", "abandoned"]);

export const RunStatusSchema = v.picklist(["active", "ended"]);

export const RepositoryStatusSchema = v.picklist(["active", "inactive"]);

export const ITermSessionListSchema = v.array(v.object({ id: NonEmptyStringSchema }));

export const PositiveIntegerSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(1));

export type HookPayload = v.InferOutput<typeof HookPayloadSchema>;
export type Config = v.InferOutput<typeof ConfigSchema>;
