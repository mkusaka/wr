import * as v from "valibot";

export const NonEmptyStringSchema = v.pipe(v.string(), v.nonEmpty());

export const CliSchema = v.picklist(["codex", "claude", "devin"]);

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

export const ToolHookPayloadSchema = v.object({
  session_id: NonEmptyStringSchema,
  cwd: NonEmptyStringSchema,
  tool_name: v.optional(v.string()),
  tool_input: v.optional(v.looseObject({ command: v.optional(v.string()) })),
  tool_response: v.optional(v.unknown()),
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

const slackHostPattern = /^[a-z0-9-]+\.slack\.com$/;
const slackArchivePattern = /^\/archives\/([A-Z0-9]+)\/p(\d{16})$/;
const slackTsPattern = /^\d+\.\d{6}$/;

export function slackConversationKey(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (!slackHostPattern.test(parsed.hostname)) return undefined;
    const match = parsed.pathname.match(slackArchivePattern);
    if (!match) return undefined;
    const channelId = match[1]!;
    const pTimestamp = match[2]!;
    const threadTs = parsed.searchParams.get("thread_ts");
    if (threadTs) {
      if (!slackTsPattern.test(threadTs)) return undefined;
      return `${channelId}/${threadTs}`;
    }
    const derivedTs = `${pTimestamp.slice(0, 10)}.${pTimestamp.slice(10, 16)}`;
    if (!slackTsPattern.test(derivedTs)) return undefined;
    return `${channelId}/${derivedTs}`;
  } catch {
    return undefined;
  }
}

export const SlackThreadUrlSchema = v.pipe(
  v.string(),
  v.url(),
  v.check(
    (value) => slackConversationKey(value) !== undefined,
    "URL must be a Slack thread permalink",
  ),
);

export function toolResponseText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null) return "";
  const response = value as { output?: unknown; stdout?: unknown };
  if (typeof response.output === "string") return response.output;
  if (typeof response.stdout === "string") return response.stdout;
  return "";
}

// ponytail: command文字列のマッチなので、取りこぼしは手動の wr pr add で補う。
export function isPullRequestCreateCommand(command: string): boolean {
  return /\bgh\s+pr\s+create\b/.test(command);
}

export function extractPullRequestUrls(
  text: string,
): Array<{ repo: string; number: number; url: string }> {
  const pattern = /https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)\b/g;
  const seen = new Set<string>();
  const pullRequests: Array<{ repo: string; number: number; url: string }> = [];
  for (const match of text.matchAll(pattern)) {
    const url = match[0]!;
    const repo = match[1]!;
    const number = Number(match[2]);
    if (seen.has(url)) continue;
    seen.add(url);
    pullRequests.push({ repo, number, url });
  }
  return pullRequests;
}

export function extractSlackThreadUrls(text: string): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const candidate of text.match(/https?:\/\/[^\s<>"']+/g) ?? []) {
    const url = candidate.replace(/[),.;!?]+$/g, "");
    const key = slackConversationKey(url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    urls.push(url);
  }
  return urls;
}

export type HookPayload = v.InferOutput<typeof HookPayloadSchema>;
export type ToolHookPayload = v.InferOutput<typeof ToolHookPayloadSchema>;
export type Config = v.InferOutput<typeof ConfigSchema>;
