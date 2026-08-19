import { describe, expect, test } from "bun:test";
import {
  filterLedger,
  type ConversationLink,
  type Device,
  type PullRequest,
  type Repository,
  type Run,
  type Task,
  type Worktree,
} from "../web/pages/Tasks/Index.tsx";

const tasks: Task[] = [
  {
    issueId: "MOQ-100",
    title: "Add patient search",
    status: "active",
    updatedAt: "2026-08-15 10:00:00",
    deviceIds: ["device-a"],
    deviceNames: ["Work laptop"],
    repoRoots: ["/src/example/wr"],
    worktreePaths: ["/src/example/wr/worktrees/patient"],
  },
];
const runs: Run[] = [
  {
    id: "run-a",
    cliSessionId: "session-a",
    cli: "codex",
    externalSessionId: "session-a",
    terminalId: "terminal-a",
    startedCwd: "/src/example/wr/worktrees/patient",
    source: "startup",
    status: "active",
    startedAt: "2026-08-15 11:59:00",
    updatedAt: "2026-08-15 12:00:00",
    endedAt: null,
    deviceIds: ["device-a"],
    deviceNames: ["Work laptop"],
    repoRoots: ["/src/example/wr"],
    worktreePaths: ["/src/example/wr/worktrees/patient"],
  },
];
const pullRequests: PullRequest[] = [
  {
    repo: "example/wr",
    number: 42,
    url: "https://github.com/example/wr/pull/42",
    headBranch: "feature/patient-search",
    baseBranch: "main",
    state: "open",
    updatedAt: "2026-08-15 11:00:00",
    deviceIds: ["device-a"],
    deviceNames: ["Work laptop"],
    repoRoots: ["/src/example/wr"],
    worktreePaths: ["/src/example/wr/worktrees/patient"],
  },
];
const conversationLinks: ConversationLink[] = [
  {
    id: "conversation-a",
    cliSessionId: "session-a",
    url: "https://moqona.slack.com/archives/C0123456789/p1234567890123456?thread_ts=1234567890.123456",
    repoRoot: "/src/example/wr",
    worktreePath: "/src/example/wr/worktrees/patient",
    createdAt: "2026-08-15 12:00:00",
    deviceIds: ["device-a"],
    deviceNames: ["Work laptop"],
    tasks: [{ issueId: "MOQ-100", title: "Add patient search", status: "active" }],
  },
];
const devices: Device[] = [{ id: "device-a", name: "Work laptop" }];
const repositories: Repository[] = [{ repoRoot: "/src/example/wr" }];
const worktrees: Worktree[] = [{ worktreePath: "/src/example/wr/worktrees/patient" }];
const ledger = { runs, tasks, pullRequests, conversationLinks, devices, repositories, worktrees };

describe("web ledger filters", () => {
  test.each([
    ["", "all", "current", ["MOQ-100"], [42], ["conversation-a"]],
    ["MOQ-100", "all", "all", ["MOQ-100"], [], ["conversation-a"]],
    ["patient", "all", "all", ["MOQ-100"], [42], ["conversation-a"]],
    ["example/wr#42", "all", "all", [], [42], []],
    ["https://github.com/example/wr/pull/42", "all", "all", [], [42], []],
    ["feature/patient-search", "pullRequests", "open", [], [42], []],
    ["", "tasks", "active", ["MOQ-100"], [], []],
    ["moqona.slack.com", "conversations", "all", [], [], ["conversation-a"]],
    ["C0123456789", "all", "all", [], [], ["conversation-a"]],
  ])(
    "filters query %s, type %s, and state %s",
    (query, type, state, expectedTasks, expectedPullRequests, expectedConversations) => {
      const result = filterLedger(ledger, {
        query,
        type,
        state,
        device: "all",
        repository: "all",
        worktree: "all",
      });
      expect(result.tasks.map((task) => task.issueId)).toEqual(expectedTasks);
      expect(result.pullRequests.map((pullRequest) => pullRequest.number)).toEqual(
        expectedPullRequests,
      );
      expect(result.conversationLinks.map((conversation) => conversation.id)).toEqual(
        expectedConversations,
      );
    },
  );

  test("current includes open and active tasks and only open pull requests", () => {
    const result = filterLedger(
      {
        ...ledger,
        tasks: [
          ...tasks,
          { ...tasks[0]!, issueId: "MOQ-101", status: "open" },
          { ...tasks[0]!, issueId: "MOQ-102", status: "done" },
        ],
        pullRequests: [...pullRequests, { ...pullRequests[0]!, number: 43, state: "closed" }],
      },
      {
        query: "",
        type: "all",
        state: "current",
        device: "all",
        repository: "all",
        worktree: "all",
      },
    );

    expect(result.tasks.map((task) => task.issueId)).toEqual(["MOQ-100", "MOQ-101"]);
    expect(result.pullRequests.map((pullRequest) => pullRequest.number)).toEqual([42]);
    expect(result.runs.map((run) => run.id)).toEqual(["run-a"]);
    expect(result.conversationLinks.map((conversation) => conversation.id)).toEqual([
      "conversation-a",
    ]);
  });

  test("filters runs by query", () => {
    const result = filterLedger(ledger, {
      query: "terminal-a",
      type: "runs",
      state: "current",
      device: "all",
      repository: "all",
      worktree: "all",
    });
    expect(result.runs.map((run) => run.id)).toEqual(["run-a"]);
  });

  test.each([
    ["device-a", "all", "all"],
    ["all", "/src/example/wr", "all"],
    ["all", "all", "/src/example/wr/worktrees/patient"],
  ])("filters by device %s, repository %s, and worktree %s", (device, repository, worktree) => {
    const result = filterLedger(ledger, {
      query: "",
      type: "all",
      state: "all",
      device,
      repository,
      worktree,
    });
    expect(result.tasks.map((task) => task.issueId)).toEqual(["MOQ-100"]);
    expect(result.pullRequests.map((pullRequest) => pullRequest.number)).toEqual([42]);
    expect(result.conversationLinks.map((conversation) => conversation.id)).toEqual([
      "conversation-a",
    ]);
  });
});
