import * as v from "valibot";
import {
  NonEmptyStringSchema,
  PullRequestStateSchema,
  SessionIdentitySchema,
  SlackThreadUrlSchema,
} from "./validation.ts";

export const CheckoutInputSchema = v.object({
  repoRoot: NonEmptyStringSchema,
  worktreePath: NonEmptyStringSchema,
  branch: v.nullable(v.string()),
});

export type CheckoutInput = v.InferOutput<typeof CheckoutInputSchema>;
export type SessionIdentity = v.InferOutput<typeof SessionIdentitySchema>;

export const ContextInputSchema = v.object({
  session: v.optional(SessionIdentitySchema),
  runId: v.optional(NonEmptyStringSchema),
  checkout: v.nullable(CheckoutInputSchema),
  terminalId: v.optional(NonEmptyStringSchema),
});

export type ContextInput = v.InferOutput<typeof ContextInputSchema>;

export const PullRequestInputSchema = v.object({
  repo: NonEmptyStringSchema,
  number: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  url: v.pipe(v.string(), v.url()),
  headBranch: NonEmptyStringSchema,
  baseBranch: NonEmptyStringSchema,
  state: PullRequestStateSchema,
});

export type PullRequestInput = v.InferOutput<typeof PullRequestInputSchema>;

export type FocusTarget = {
  id: string;
  session: string;
  itermSessionId: string;
  taskIds: string;
  repoRoots: string[];
  branches: string;
  pullRequests: string;
  prUrls: string;
  startedCwd: string | null;
};

export const ConversationLinkInputSchema = v.object({
  url: SlackThreadUrlSchema,
  context: ContextInputSchema,
});

export type ShowTask = {
  linearIssueId: string;
  title: string | null;
  status: string;
  executions: Array<Record<string, unknown>>;
  pullRequests: Array<Record<string, unknown>>;
  links: Array<Record<string, unknown>>;
};
