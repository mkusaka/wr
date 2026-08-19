import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NuqsAdapter } from "nuqs/adapters/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import TasksIndex, {
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
    title: "Patient search",
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
const devices: Device[] = [{ id: "device-a", name: "Work laptop" }];
const repositories: Repository[] = [{ repoRoot: "/src/example/wr" }];
const worktrees: Worktree[] = [
  { worktreePath: "/src/example/wr/worktrees/patient" },
  { worktreePath: "/src/example/wr/worktrees/admin" },
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
    tasks: [],
  },
];
const pageProps = {
  runs,
  tasks,
  pullRequests,
  conversationLinks,
  devices,
  repositories,
  worktrees,
};

function renderPage(props = pageProps) {
  return render(
    <NuqsAdapter>
      <TasksIndex {...props} />
    </NuqsAdapter>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  document.documentElement.classList.remove("dark");
  window.history.replaceState(null, "", "/");
});

describe("TasksIndex", () => {
  test("switches between light and dark mode", () => {
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Switch to dark mode" }));
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem("wr-theme")).toBe("dark");

    fireEvent.click(screen.getByRole("button", { name: "Switch to light mode" }));
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(localStorage.getItem("wr-theme")).toBe("light");
  });

  test("shows current tasks, pull requests, and conversations by default", () => {
    renderPage();

    expect(screen.getAllByText("Devices: Work laptop")).toHaveLength(2);
    expect(screen.getByRole("button", { name: /Current State/ })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /Runs\s*1/ })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /Tasks\s*1/ })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /Pull requests\s*1/ })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /Conversations\s*1/ })).toBeTruthy();
    expect(
      screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent),
    ).toEqual(["Runs1", "Tasks 1", "Pull requests1", "Conversations1"]);
    expect(new URLSearchParams(window.location.search).has("state")).toBe(false);
  });

  test("searches tasks, pull requests, and conversations by device name", async () => {
    renderPage();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search" }), {
      target: { value: "Work laptop" },
    });

    expect(screen.getByRole("heading", { name: /Tasks\s*1/ })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /Pull requests\s*1/ })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /Conversations\s*1/ })).toBeTruthy();
    await waitFor(() =>
      expect(new URLSearchParams(window.location.search).get("q")).toBe("Work laptop"),
    );
  });

  test("searches conversation links by URL", async () => {
    renderPage();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search" }), {
      target: { value: "moqona.slack.com" },
    });

    expect(screen.queryByRole("heading", { name: /Runs\s*1/ })).toBeNull();
    expect(screen.queryByRole("heading", { name: /Tasks\s*1/ })).toBeNull();
    expect(screen.queryByRole("heading", { name: /Pull requests\s*1/ })).toBeNull();
    expect(screen.getByRole("heading", { name: /Conversations\s*1/ })).toBeTruthy();
    await waitFor(() =>
      expect(new URLSearchParams(window.location.search).get("q")).toBe("moqona.slack.com"),
    );
  });

  test("restores filters from the URL", () => {
    window.history.replaceState(
      null,
      "",
      "/?q=patient&type=pullRequests&state=open&device=device-a&repo=%2Fsrc%2Fexample%2Fwr&worktree=%2Fsrc%2Fexample%2Fwr%2Fworktrees%2Fpatient",
    );
    renderPage();

    expect(screen.getByRole<HTMLInputElement>("searchbox", { name: "Search" }).value).toBe(
      "patient",
    );
    expect(screen.queryByRole("heading", { name: /Tasks\s*1/ })).toBeNull();
    expect(screen.getByRole("heading", { name: /Pull requests\s*1/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Pull requests Type/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Work laptop Device/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /\/src\/example\/wr Repository/ })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /\/src\/example\/wr\/worktrees\/patient Worktree/ }),
    ).toBeTruthy();
  });

  test("filters results when the type selector changes", async () => {
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: /All types Type/ }));
    fireEvent.click(await screen.findByRole("option", { name: "Pull requests" }));

    expect(screen.queryByRole("heading", { name: /Runs\s*1/ })).toBeNull();
    expect(screen.queryByRole("heading", { name: /Tasks\s*1/ })).toBeNull();
    expect(screen.getByRole("heading", { name: /Pull requests\s*1/ })).toBeTruthy();
    await waitFor(() =>
      expect(new URLSearchParams(window.location.search).get("type")).toBe("pullRequests"),
    );
  });

  test("searches worktree options", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      const options = url.includes("q=patient")
        ? [{ worktreePath: "/src/remote/worktrees/patient-results" }]
        : [];
      return Promise.resolve(
        new Response(JSON.stringify(options), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage({ ...pageProps, worktrees: [] });

    fireEvent.click(screen.getByRole("button", { name: /All worktrees Worktree/ }));
    const worktree = await screen.findByRole("searchbox", { name: "Search worktrees" });
    worktree.focus();
    fireEvent.input(worktree, { target: { value: "p" } });
    fireEvent.input(worktree, { target: { value: "patient" } });
    await waitFor(() => expect((worktree as HTMLInputElement).value).toBe("patient"));

    expect(
      await screen.findByRole("option", { name: "/src/remote/worktrees/patient-results" }),
    ).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith("/api/select-options/worktrees?q=p");
    expect(fetchMock).toHaveBeenCalledWith("/api/select-options/worktrees?q=patient");
  });

  test("shows pull request states only for pull requests", async () => {
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: /All types Type/ }));
    fireEvent.click(await screen.findByRole("option", { name: "Pull requests" }));
    fireEvent.click(screen.getByRole("button", { name: /Current State/ }));

    expect(await screen.findByRole("option", { name: "Merged" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Closed" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Active" })).toBeNull();
    expect(screen.queryByRole("option", { name: "Done" })).toBeNull();
    expect(screen.queryByRole("option", { name: "Cancelled" })).toBeNull();
  });

  test("expands a pull request and copies resume and focus commands", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            parentPullRequest: null,
            childPullRequests: [],
            tasks: [],
            runs: [
              {
                id: "run-42",
                cli: "claude",
                externalSessionId: "session-42",
                terminalId: "terminal-42",
                startedAt: "2026-08-15 12:00:00",
                endedAt: null,
              },
              {
                id: "run-codex",
                cli: "codex",
                externalSessionId: "session-codex",
                terminalId: "terminal-codex",
                startedAt: "2026-08-15 12:01:00",
                endedAt: null,
              },
              {
                id: "run-devin",
                cli: "devin",
                externalSessionId: "session-devin",
                terminalId: "terminal-devin",
                startedAt: "2026-08-15 12:02:00",
                endedAt: null,
              },
            ],
            checkouts: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    renderPage({
      runs: [],
      tasks: [],
      pullRequests,
      conversationLinks: [],
      devices: [],
      repositories: [],
      worktrees: [],
    });

    fireEvent.click(screen.getByRole("button", { name: "feature/patient-search" }));
    fireEvent.click(screen.getByRole("button", { name: "main" }));
    fireEvent.click(screen.getByRole("button", { name: /example\/wr#42/ }));
    const resume = await screen.findByRole("button", {
      name: "claude --resume session-42",
    });
    const codexResume = screen.getByRole("button", { name: "codex resume session-codex" });
    const devinResume = screen.getByRole("button", { name: "devin --resume session-devin" });
    const focus = screen.getByRole("button", { name: "wr run focus run-42" });
    fireEvent.click(resume);
    fireEvent.click(codexResume);
    fireEvent.click(devinResume);
    fireEvent.click(focus);

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("feature/patient-search");
      expect(writeText).toHaveBeenCalledWith("main");
      expect(writeText).toHaveBeenCalledWith("claude --resume session-42");
      expect(writeText).toHaveBeenCalledWith("codex resume session-codex");
      expect(writeText).toHaveBeenCalledWith("devin --resume session-devin");
      expect(writeText).toHaveBeenCalledWith("wr run focus run-42");
    });
  });
});
