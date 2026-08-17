import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, test } from "vitest";
import { createApp } from "../worker/app.ts";
import type { Env, Principal } from "../worker/auth.ts";
import * as schema from "../worker/schema.ts";

const app = createApp(async (incomingRequest): Promise<Principal> => {
  const token = incomingRequest.headers.get("X-Test-Token");
  if (!token) throw new Error("missing token");
  return {
    subject: incomingRequest.headers.get("X-Test-User") || "owner",
    email: "owner@example.test",
  };
});

function request(
  path: string,
  token: string,
  body?: unknown,
  method?: string,
  user = "owner",
  deviceName = token,
) {
  return app.request(
    path,
    {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: {
        "X-Test-Token": token,
        "X-Test-User": user,
        "X-Wr-Device-Id": token,
        "X-Wr-Device-Name": deviceName,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env as unknown as Env,
  );
}

const checkout = {
  repoRoot: "/src/example",
  worktreePath: "/src/example",
  branch: "main",
};

beforeEach(async () => {
  const db = drizzle((env as unknown as Env).DB, { schema });
  await db.delete(schema.sessionRunPullRequests);
  await db.delete(schema.taskPullRequests);
  await db.delete(schema.conversationLinks);
  await db.delete(schema.workpadLinks);
  await db.delete(schema.executions);
  await db.delete(schema.sessionRunCheckouts);
  await db.delete(schema.sessionRuns);
  await db.delete(schema.checkouts);
  await db.delete(schema.pullRequests);
  await db.delete(schema.tasks);
  await db.delete(schema.cliSessions);
  await db.delete(schema.devices);
  await db.delete(schema.users);
});

describe("wr Worker API", () => {
  test("returns searchable resources in the Inertia page props", async () => {
    const payload = { session_id: "page-session", cwd: "/src/example", source: "startup" };
    await request("/api/session-events", "page-device", { cli: "codex", payload, checkout });
    const context = {
      session: { cli: "codex", externalSessionId: payload.session_id },
      checkout,
    };
    await request("/api/tasks/MOQ-PAGE/start", "page-device", {
      context,
      title: "Page task",
    });
    await request("/api/pull-requests", "page-device", {
      pullRequest: {
        repo: "example/repo",
        number: 100,
        url: "https://github.com/example/repo/pull/100",
        headBranch: "feature/page",
        baseBranch: "main",
        state: "open",
      },
      task: "MOQ-PAGE",
      context,
    });

    const response = await app.request(
      "/",
      {
        headers: {
          Accept: "text/html, application/xhtml+xml",
          "X-Inertia": "true",
          "X-Test-Token": "web",
        },
      },
      env as unknown as Env,
    );
    const page = await response.json<{
      component: string;
      props: {
        runs: Array<{ externalSessionId: string; status: string; updatedAt: string }>;
        tasks: Array<{ deviceIds: string[]; repoRoots: string[]; worktreePaths: string[] }>;
        pullRequests: Array<{
          deviceIds: string[];
          repoRoots: string[];
          worktreePaths: string[];
        }>;
        conversationLinks: Array<{ url: string }>;
        devices: unknown[];
        repositories: unknown[];
        worktrees: unknown[];
      };
    }>();
    expect(page.component).toBe("Tasks/Index");
    expect(page.props.runs).toMatchObject([
      { externalSessionId: "page-session", status: "active", updatedAt: expect.any(String) },
    ]);
    expect(page.props.tasks).toHaveLength(1);
    expect(page.props.tasks[0]).toMatchObject({
      deviceIds: ["page-device"],
      repoRoots: ["/src/example"],
      worktreePaths: ["/src/example"],
    });
    expect(page.props.pullRequests[0]).toMatchObject({
      deviceIds: ["page-device"],
      repoRoots: ["/src/example"],
      worktreePaths: ["/src/example"],
    });
    expect(page.props.devices).toHaveLength(1);
    expect(page.props.repositories).toHaveLength(1);
    expect(page.props.worktrees).toHaveLength(1);
  });

  test("searches selector options on the server", async () => {
    await request("/api/session-events", "alpha-device", {
      cli: "codex",
      payload: { session_id: "alpha-session", cwd: "/src/patient", source: "startup" },
      checkout: {
        repoRoot: "/src/patient-repo",
        worktreePath: "/src/patient-repo/worktrees/patient-search",
        branch: "feature/patient-search",
      },
    });
    await request("/api/session-events", "beta-device", {
      cli: "codex",
      payload: { session_id: "beta-session", cwd: "/src/admin", source: "startup" },
      checkout: {
        repoRoot: "/src/admin-repo",
        worktreePath: "/src/admin-repo/worktrees/settings",
        branch: "feature/settings",
      },
    });

    expect(
      await (await request("/api/select-options/devices?q=alpha", "viewer-device")).json(),
    ).toEqual([{ id: "alpha-device", name: "alpha-device" }]);
    expect(
      await (await request("/api/select-options/repositories?q=patient", "viewer-device")).json(),
    ).toEqual([{ repoRoot: "/src/patient-repo" }]);
    expect(
      await (await request("/api/select-options/worktrees?q=patient", "viewer-device")).json(),
    ).toEqual([{ worktreePath: "/src/patient-repo/worktrees/patient-search" }]);
  });

  test("sorts top page records by updated time descending", async () => {
    const db = drizzle((env as unknown as Env).DB, { schema });
    await request("/api/session-events", "order-device", {
      cli: "codex",
      payload: { session_id: "older-session", cwd: "/src/example", source: "startup" },
      checkout,
    });
    await request("/api/session-events", "order-device", {
      cli: "codex",
      payload: { session_id: "newer-session", cwd: "/src/example", source: "startup" },
      checkout,
    });
    await request("/api/tasks", "order-device", { issue: "OLDER-TASK" });
    await request("/api/tasks", "order-device", { issue: "NEWER-TASK" });
    await request("/api/pull-requests", "order-device", {
      pullRequest: {
        repo: "example/repo",
        number: 1,
        url: "https://github.com/example/repo/pull/1",
        headBranch: "older",
        baseBranch: "main",
        state: "open",
      },
    });
    await request("/api/pull-requests", "order-device", {
      pullRequest: {
        repo: "example/repo",
        number: 2,
        url: "https://github.com/example/repo/pull/2",
        headBranch: "newer",
        baseBranch: "main",
        state: "open",
      },
    });
    const orderedSessions = await db
      .select({
        id: schema.cliSessions.id,
        externalSessionId: schema.cliSessions.externalSessionId,
      })
      .from(schema.cliSessions);
    const olderSession = orderedSessions.find(
      (session) => session.externalSessionId === "older-session",
    )!;
    const newerSession = orderedSessions.find(
      (session) => session.externalSessionId === "newer-session",
    )!;
    await db
      .update(schema.sessionRuns)
      .set({ lastSeenAt: "2026-01-01 00:00:00" })
      .where(eq(schema.sessionRuns.cliSessionId, olderSession.id));
    await db
      .update(schema.sessionRuns)
      .set({ lastSeenAt: "2026-01-02 00:00:00" })
      .where(eq(schema.sessionRuns.cliSessionId, newerSession.id));
    await db
      .update(schema.tasks)
      .set({ updatedAt: "2026-01-01 00:00:00" })
      .where(eq(schema.tasks.issueId, "OLDER-TASK"));
    await db
      .update(schema.tasks)
      .set({ updatedAt: "2026-01-02 00:00:00" })
      .where(eq(schema.tasks.issueId, "NEWER-TASK"));
    await db
      .update(schema.pullRequests)
      .set({ updatedAt: "2026-01-01 00:00:00" })
      .where(eq(schema.pullRequests.number, 1));
    await db
      .update(schema.pullRequests)
      .set({ updatedAt: "2026-01-02 00:00:00" })
      .where(eq(schema.pullRequests.number, 2));

    const response = await app.request(
      "/",
      { headers: { Accept: "text/html", "X-Inertia": "true", "X-Test-Token": "web" } },
      env as unknown as Env,
    );
    const page = await response.json<{
      props: {
        runs: Array<{ externalSessionId: string }>;
        tasks: Array<{ issueId: string }>;
        pullRequests: Array<{ number: number }>;
      };
    }>();
    expect(page.props.runs.map((run) => run.externalSessionId)).toEqual([
      "newer-session",
      "older-session",
    ]);
    expect(page.props.tasks.map((task) => task.issueId)).toEqual(["NEWER-TASK", "OLDER-TASK"]);
    expect(page.props.pullRequests.map((pullRequest) => pullRequest.number)).toEqual([2, 1]);
  });

  test("scopes resource lists to the current device by default", async () => {
    const payload = { session_id: "session-a", cwd: "/src/example", source: "startup" };
    expect(
      (await request("/api/session-events", "device-a", { cli: "codex", payload, checkout }))
        .status,
    ).toBe(201);
    expect(
      (await request("/api/tasks", "device-a", { issue: "MOQ-1", title: "First" })).status,
    ).toBe(201);

    const tasks = await (
      await request("/api/tasks", "device-b")
    ).json<Array<{ linearIssueId: string }>>();
    expect(tasks).toHaveLength(0);

    const allTasks = await (
      await request("/api/tasks?all=true", "device-b")
    ).json<Array<{ linearIssueId: string }>>();
    expect(allTasks.map((task) => task.linearIssueId)).toEqual(["MOQ-1"]);

    const deviceASessions = await (
      await request("/api/device/resources/sessions", "device-a")
    ).json<unknown[]>();
    const deviceBSessions = await (
      await request("/api/device/resources/sessions", "device-b")
    ).json<unknown[]>();
    expect(deviceASessions).toHaveLength(1);
    expect(deviceBSessions).toHaveLength(0);
    expect(
      await (
        await request("/api/device/resources/sessions?all=true", "device-b")
      ).json<unknown[]>(),
    ).toHaveLength(1);
  });

  test("stores the first prompt even when it arrives before session start", async () => {
    const db = drizzle((env as unknown as Env).DB, { schema });
    const payload = {
      session_id: "prompt-session",
      cwd: "/src/example",
      prompt: "Implement prompt storage",
    };
    expect(
      (await request("/api/session-prompts", "prompt-device", { cli: "codex", payload })).status,
    ).toBe(200);
    await request("/api/session-events", "prompt-device", {
      cli: "codex",
      payload: { session_id: payload.session_id, cwd: payload.cwd, source: "startup" },
      checkout,
    });
    await request("/api/session-prompts", "prompt-device", {
      cli: "codex",
      payload: { ...payload, prompt: "Do not overwrite the first prompt" },
    });

    const session = await db
      .select({ initialPrompt: schema.cliSessions.initialPrompt })
      .from(schema.cliSessions)
      .where(eq(schema.cliSessions.externalSessionId, payload.session_id))
      .get();
    expect(session?.initialPrompt).toBe(payload.prompt);
  });

  test("records Devin lifecycle events and prompts", async () => {
    const payload = {
      session_id: "devin-session",
      cwd: "/src/example",
      source: "startup",
    };
    expect(
      (
        await request("/api/session-events", "devin-device", {
          cli: "devin",
          payload,
          checkout,
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await request("/api/session-prompts", "devin-device", {
          cli: "devin",
          payload: { ...payload, prompt: "Track this Devin session" },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request("/api/session-ends", "devin-device", {
          cli: "devin",
          payload,
        })
      ).status,
    ).toBe(200);

    const db = drizzle((env as unknown as Env).DB, { schema });
    const session = await db
      .select({ cli: schema.cliSessions.cli, initialPrompt: schema.cliSessions.initialPrompt })
      .from(schema.cliSessions)
      .where(eq(schema.cliSessions.externalSessionId, payload.session_id))
      .get();
    expect(session).toEqual({ cli: "devin", initialPrompt: "Track this Devin session" });
  });

  test("sorts sessions by updated time descending", async () => {
    const db = drizzle((env as unknown as Env).DB, { schema });
    await request("/api/session-events", "sort-device", {
      cli: "codex",
      payload: { session_id: "older-session", cwd: "/src/example", source: "startup" },
      checkout,
    });
    await request("/api/session-events", "sort-device", {
      cli: "codex",
      payload: { session_id: "newer-session", cwd: "/src/example", source: "startup" },
      checkout,
    });
    await db
      .update(schema.cliSessions)
      .set({ updatedAt: "2026-01-01 00:00:00" })
      .where(eq(schema.cliSessions.externalSessionId, "older-session"));
    await db
      .update(schema.cliSessions)
      .set({ updatedAt: "2026-01-02 00:00:00" })
      .where(eq(schema.cliSessions.externalSessionId, "newer-session"));

    const sessions = await (
      await request("/api/device/resources/sessions", "sort-device")
    ).json<Array<{ externalSessionId: string }>>();
    expect(sessions.map((session) => session.externalSessionId)).toEqual([
      "newer-session",
      "older-session",
    ]);
  });

  test("ends current-device runs whose iTerm2 sessions no longer exist", async () => {
    const staleRun = await (
      await request("/api/session-events", "sync-device", {
        cli: "codex",
        payload: { session_id: "stale-session", cwd: "/src/example", source: "startup" },
        checkout,
        terminalId: "w0t0p0:stale-terminal",
      })
    ).json<{ runId: string }>();
    const liveRun = await (
      await request("/api/session-events", "sync-device", {
        cli: "codex",
        payload: { session_id: "live-session", cwd: "/src/example", source: "startup" },
        checkout,
        terminalId: "w0t0p0:live-terminal",
      })
    ).json<{ runId: string }>();
    const terminalLessRun = await (
      await request("/api/session-events", "sync-device", {
        cli: "codex",
        payload: { session_id: "terminal-less-session", cwd: "/src/example", source: "startup" },
        checkout,
      })
    ).json<{ runId: string }>();
    const otherDeviceRun = await (
      await request("/api/session-events", "other-device", {
        cli: "codex",
        payload: { session_id: "other-session", cwd: "/src/example", source: "startup" },
        checkout,
        terminalId: "w0t0p0:other-terminal",
      })
    ).json<{ runId: string }>();

    expect(
      await (
        await request("/api/runs/sync", "sync-device", {
          candidateRunIds: [
            staleRun.runId,
            liveRun.runId,
            terminalLessRun.runId,
            otherDeviceRun.runId,
          ],
          liveTerminalIds: ["live-terminal"],
        })
      ).json(),
    ).toEqual({ ended: 1 });

    const runs = await (
      await request("/api/device/resources/runs", "sync-device")
    ).json<Array<{ id: string; status: string; endReason: string | null }>>();
    expect(runs.find((run) => run.id === staleRun.runId)).toMatchObject({
      status: "ended",
      endReason: "terminal_closed",
    });
    expect(runs.find((run) => run.id === liveRun.runId)?.status).toBe("active");
    expect(runs.find((run) => run.id === terminalLessRun.runId)?.status).toBe("active");
    expect(runs.find((run) => run.id === otherDeviceRun.runId)).toBeUndefined();
    const allRuns = await (
      await request("/api/device/resources/runs?all=true", "sync-device")
    ).json<Array<{ id: string; status: string }>>();
    expect(allRuns.find((run) => run.id === otherDeviceRun.runId)?.status).toBe("active");
  });

  test("records task execution and focus targets from session start", async () => {
    const payload = { session_id: "session-a", cwd: "/src/example", source: "startup" };
    await request("/api/session-events", "device-a", {
      cli: "codex",
      payload,
      checkout,
      terminalId: "w0t0p0:terminal-a",
    });
    const context = {
      session: { cli: "codex", externalSessionId: "session-a" },
      checkout,
      terminalId: "w0t0p0:terminal-a",
    };
    expect(
      (await request("/api/tasks/MOQ-2/start", "device-a", { context, title: "Work" })).status,
    ).toBe(200);
    const targets = await (
      await request("/api/focus-targets", "device-a")
    ).json<Array<{ taskIds: string }>>();
    expect(targets).toHaveLength(1);
    expect(targets[0]?.taskIds).toBe("MOQ-2");
    const tasks = await (
      await request("/api/tasks", "device-a")
    ).json<Array<{ repoRoots: string[]; worktreePaths: string[] }>>();
    expect(tasks[0]?.repoRoots).toEqual(["/src/example"]);
    expect(tasks[0]?.worktreePaths).toEqual(["/src/example"]);
  });

  test("updates execution state when tasks finish, reopen, or cancel", async () => {
    const payload = { session_id: "lifecycle-session", cwd: "/src/example", source: "startup" };
    await request("/api/session-events", "lifecycle-device", { cli: "codex", payload, checkout });
    const context = {
      session: { cli: "codex", externalSessionId: payload.session_id },
      checkout,
    };
    await request("/api/tasks/MOQ-4/start", "lifecycle-device", { context });
    await request("/api/tasks/MOQ-4/done", "lifecycle-device", { context });
    let executions = await (
      await request("/api/device/resources/executions", "lifecycle-device")
    ).json<Array<{ status: string }>>();
    expect(executions.map((row) => row.status)).toEqual(["finished"]);

    const reopened = await (
      await request("/api/tasks/MOQ-4/start", "lifecycle-device", { context })
    ).json<{ reopened: boolean }>();
    expect(reopened.reopened).toBe(true);
    await request("/api/tasks/MOQ-4/cancel", "lifecycle-device", { context });
    executions = await (
      await request("/api/device/resources/executions", "lifecycle-device")
    ).json<Array<{ status: string }>>();
    expect(executions.map((row) => row.status).toSorted()).toEqual(["abandoned", "finished"]);
  });

  test("implicitly registers a missing session and run for task operations", async () => {
    const context = {
      session: { cli: "codex" as const, externalSessionId: "implicit-session" },
      checkout,
    };
    expect(
      (await request("/api/tasks/MOQ-IMPLICIT/start", "implicit-device", { context })).status,
    ).toBe(200);
    expect(
      (await request("/api/tasks/MOQ-IMPLICIT/done", "implicit-device", { context })).status,
    ).toBe(200);

    const sessions = await (
      await request("/api/device/resources/sessions", "implicit-device")
    ).json<Array<{ externalSessionId: string }>>();
    expect(sessions.map((row) => row.externalSessionId)).toEqual(["implicit-session"]);
    const executions = await (
      await request("/api/device/resources/executions", "implicit-device")
    ).json<Array<{ status: string }>>();
    expect(executions.map((row) => row.status)).toEqual(["finished"]);
  });

  test("registers a missing task before completing it", async () => {
    const context = {
      session: { cli: "codex" as const, externalSessionId: "implicit-done-session" },
      checkout,
    };
    const response = await request("/api/tasks/MOQ-IMPLICIT-DONE/done", "implicit-done-device", {
      context,
    });
    expect(response.status).toBe(200);
    const tasks = await (
      await request("/api/tasks", "implicit-done-device")
    ).json<Array<{ linearIssueId: string; status: string }>>();
    expect(tasks[0]?.linearIssueId).toBe("MOQ-IMPLICIT-DONE");
    expect(tasks[0]?.status).toBe("done");
  });

  test("registers a missing task when adding a pull request", async () => {
    const pullRequest = {
      repo: "example/repo",
      number: 1,
      url: "https://github.com/example/repo/pull/1",
      headBranch: "feature/test",
      baseBranch: "main",
      state: "open",
    };
    expect(
      (await request("/api/pull-requests", "pr-device", { pullRequest, task: "MOQ-404" })).status,
    ).toBe(200);
    const tasks = await (
      await request("/api/tasks", "pr-device")
    ).json<Array<{ linearIssueId: string }>>();
    expect(tasks.map((task) => task.linearIssueId)).toEqual(["MOQ-404"]);
  });

  test("registers a missing parent pull request and rejects self-parenting", async () => {
    const parentPullRequest = {
      repo: "example/repo",
      number: 10,
      url: "https://github.com/example/repo/pull/10",
      headBranch: "feature/parent",
      baseBranch: "main",
      state: "open",
    };
    const pullRequest = {
      ...parentPullRequest,
      number: 11,
      url: "https://github.com/example/repo/pull/11",
      headBranch: "feature/child",
    };
    expect(
      (
        await request("/api/pull-requests", "parent-device", {
          pullRequest,
          parent: 10,
          parentPullRequest,
        })
      ).status,
    ).toBe(200);
    await expect(
      (await request("/api/pull-requests", "parent-device")).json<unknown[]>(),
    ).resolves.toHaveLength(2);
    expect(
      (
        await request("/api/pull-requests", "parent-device", {
          pullRequest,
          parent: 11,
          parentPullRequest: pullRequest,
        })
      ).status,
    ).toBe(400);
  });

  test("rejects runs from another session or an ended run in context", async () => {
    const firstPayload = { session_id: "first-session", cwd: "/src/example", source: "startup" };
    const secondPayload = {
      session_id: "second-session",
      cwd: "/src/example",
      source: "startup",
    };
    const first = await (
      await request("/api/session-events", "run-device", {
        cli: "codex",
        payload: firstPayload,
        checkout,
      })
    ).json<{ runId: string }>();
    await request("/api/session-events", "run-device", {
      cli: "codex",
      payload: secondPayload,
      checkout,
    });
    expect(
      (
        await request("/api/tasks/MOQ-6/start", "run-device", {
          context: {
            session: { cli: "codex", externalSessionId: secondPayload.session_id },
            runId: first.runId,
            checkout,
          },
        })
      ).status,
    ).toBe(404);

    await request("/api/session-ends", "run-device", { cli: "codex", payload: firstPayload });
    expect(
      (
        await request("/api/tasks/MOQ-6/start", "run-device", {
          context: {
            session: { cli: "codex", externalSessionId: firstPayload.session_id },
            runId: first.runId,
            checkout,
          },
        })
      ).status,
    ).toBe(404);
  });

  test("adds and removes conversation links for root and reply Slack permalinks", async () => {
    const payload = { session_id: "conversation-session", cwd: "/src/example", source: "startup" };
    await request("/api/session-events", "conversation-device", {
      cli: "codex",
      payload,
      checkout,
    });
    const context = {
      session: { cli: "codex", externalSessionId: payload.session_id },
      checkout,
    };
    const rootUrl = "https://moqona.slack.com/archives/C0123456789/p1234567890123456";
    const replyUrl =
      "https://moqona.slack.com/archives/C9876543210/p9999999999999999?thread_ts=9876543210.999999";
    await request("/api/conversation-links", "conversation-device", { url: rootUrl, context });
    await request("/api/conversation-links", "conversation-device", { url: replyUrl, context });
    const links = await (
      await request("/api/device/resources/links", "conversation-device")
    ).json<Array<{ kind: string; ref: string }>>();
    expect(links).toHaveLength(2);

    await request(
      "/api/conversation-links",
      "conversation-device",
      { url: replyUrl, context },
      "DELETE",
    );
    const remaining = await (
      await request("/api/device/resources/links", "conversation-device")
    ).json<Array<{ kind: string; ref: string }>>();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ kind: "conversation", ref: rootUrl });

    await request(
      "/api/conversation-links",
      "conversation-device",
      { url: rootUrl, context },
      "DELETE",
    );
    await expect(
      (await request("/api/device/resources/links", "conversation-device")).json<unknown[]>(),
    ).resolves.toHaveLength(0);
  });

  test("does not remove a conversation link from another session", async () => {
    const firstPayload = {
      session_id: "first-conversation-session",
      cwd: "/src/example",
      source: "startup",
    };
    const secondPayload = {
      session_id: "second-conversation-session",
      cwd: "/src/example",
      source: "startup",
    };
    await request("/api/session-events", "session-device", {
      cli: "codex",
      payload: firstPayload,
      checkout,
    });
    await request("/api/session-events", "session-device", {
      cli: "codex",
      payload: secondPayload,
      checkout,
    });
    const firstContext = {
      session: { cli: "codex", externalSessionId: firstPayload.session_id },
      checkout,
    };
    const secondContext = {
      session: { cli: "codex", externalSessionId: secondPayload.session_id },
      checkout,
    };
    const slackUrl = "https://moqona.slack.com/archives/C0123456789/p1234567890123456";
    await request("/api/conversation-links", "session-device", {
      url: slackUrl,
      context: firstContext,
    });
    await request(
      "/api/conversation-links",
      "session-device",
      { url: slackUrl, context: secondContext },
      "DELETE",
    );
    await expect(
      (await request("/api/device/resources/links", "session-device")).json<unknown[]>(),
    ).resolves.toHaveLength(1);
  });

  test("removing a conversation link does not create a run for an ended session", async () => {
    const sessionId = "ended-conversation-session";
    const startupPayload = { session_id: sessionId, cwd: "/src/example", source: "startup" };
    await request("/api/session-events", "ended-device", {
      cli: "codex",
      payload: startupPayload,
      checkout,
    });
    const context = {
      session: { cli: "codex", externalSessionId: sessionId },
      checkout,
    };
    const slackUrl = "https://moqona.slack.com/archives/C0123456789/p1234567890123456";
    await request("/api/conversation-links", "ended-device", { url: slackUrl, context });
    await request("/api/session-ends", "ended-device", {
      cli: "codex",
      payload: { session_id: sessionId },
    });
    const beforeRuns = await (
      await request("/api/device/resources/runs", "ended-device")
    ).json<unknown[]>();
    await request("/api/conversation-links", "ended-device", { url: slackUrl, context }, "DELETE");
    const afterRuns = await (
      await request("/api/device/resources/runs", "ended-device")
    ).json<unknown[]>();
    expect(afterRuns).toHaveLength(beforeRuns.length);
  });

  test.each([
    "https://example.com/not-slack",
    "https://slack.com/archives/C0123456789/p1234567890123456",
    "https://moqona.slack.com/archives/C0123456789/p1234567890",
    "https://moqona.slack.com/archives/C0123456789/p1234567890123456?thread_ts=1234567890",
  ])("rejects invalid conversation URL %s", async (url) => {
    const payload = {
      session_id: "bad-conversation-session",
      cwd: "/src/example",
      source: "startup",
    };
    await request("/api/session-events", "bad-conversation-device", {
      cli: "codex",
      payload,
      checkout,
    });
    const context = {
      session: { cli: "codex", externalSessionId: payload.session_id },
      checkout,
    };
    expect(
      (await request("/api/conversation-links", "bad-conversation-device", { url, context }))
        .status,
    ).toBe(400);
  });

  test("show returns conversation links through task executions", async () => {
    const payload = {
      session_id: "show-conversation-session",
      cwd: "/src/example",
      source: "startup",
    };
    await request("/api/session-events", "show-conversation-device", {
      cli: "codex",
      payload,
      checkout,
    });
    const context = {
      session: { cli: "codex", externalSessionId: payload.session_id },
      checkout,
    };
    await request("/api/tasks/MOQ-CONVERSATION/start", "show-conversation-device", {
      context,
      title: "Conversation task",
    });
    const slackUrl =
      "https://moqona.slack.com/archives/C0123456789/p1234567890123456?thread_ts=1234567890.123456";
    await request("/api/conversation-links", "show-conversation-device", {
      url: slackUrl,
      context,
    });
    const result = await (
      await request("/api/show?task=MOQ-CONVERSATION", "show-conversation-device")
    ).json<Array<{ links: unknown[] }>>();
    expect(result).toHaveLength(1);
    expect(result[0]?.links).toHaveLength(1);
    const firstLink = (result[0]?.links as { kind: string; ref: string }[] | undefined)?.[0];
    expect(firstLink).toMatchObject({
      kind: "conversation",
      ref: slackUrl,
    });
  });

  test("adds and removes workpad links", async () => {
    const payload = { session_id: "workpad-session", cwd: "/src/example", source: "startup" };
    await request("/api/session-events", "workpad-device", { cli: "codex", payload, checkout });
    const context = {
      session: { cli: "codex", externalSessionId: payload.session_id },
      checkout,
    };
    await request("/api/workpad-links", "workpad-device", {
      context,
      ref: "/tmp/workpad.md",
      task: "MOQ-WORKPAD",
    });
    await expect(
      (await request("/api/device/resources/links", "workpad-device")).json<unknown[]>(),
    ).resolves.toHaveLength(1);
    await request(
      "/api/workpad-links",
      "workpad-device",
      { context, ref: "/tmp/workpad.md", task: "MOQ-WORKPAD" },
      "DELETE",
    );
    await expect(
      (await request("/api/device/resources/links", "workpad-device")).json<unknown[]>(),
    ).resolves.toHaveLength(0);
  });

  test("show returns executions, pull requests, and workpads linked to a task", async () => {
    const payload = { session_id: "show-session", cwd: "/src/example", source: "startup" };
    await request("/api/session-events", "show-device", { cli: "codex", payload, checkout });
    const context = {
      session: { cli: "codex", externalSessionId: payload.session_id },
      checkout,
    };
    await request("/api/tasks/MOQ-7/start", "show-device", { context, title: "Show task" });
    await request("/api/pull-requests", "show-device", {
      pullRequest: {
        repo: "example/repo",
        number: 7,
        url: "https://github.com/example/repo/pull/7",
        headBranch: "feature/show",
        baseBranch: "main",
        state: "open",
      },
      task: "MOQ-7",
      context,
    });
    await request("/api/workpad-links", "show-device", {
      context,
      task: "MOQ-7",
      ref: "/tmp/show.md",
    });
    const result = await (
      await request("/api/show?task=MOQ-7", "show-device")
    ).json<Array<{ executions: unknown[]; pullRequests: unknown[]; links: unknown[] }>>();
    expect(result).toHaveLength(1);
    expect(result[0]?.executions).toHaveLength(1);
    expect(result[0]?.pullRequests).toHaveLength(1);
    expect(result[0]?.links).toHaveLength(1);

    const relationships = await (
      await request("/api/pull-request-relationships?repo=example%2Frepo&number=7", "show-device")
    ).json<{ tasks: unknown[]; runs: unknown[]; checkouts: unknown[] }>();
    expect(relationships.tasks).toHaveLength(1);
    expect(relationships.runs).toHaveLength(1);
    expect(relationships.checkouts).toHaveLength(1);
  });

  test("returns 400 instead of an internal error for invalid context", async () => {
    const response = await request("/api/tasks/MOQ-5/start", "invalid-device", {
      context: { checkout: { repoRoot: 1 } },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid request" });
  });

  test("handles concurrent session starts for one device without unique constraint errors", async () => {
    const payload = { session_id: "parallel-session", cwd: "/src/example", source: "startup" };
    const responses = await Promise.all(
      Array.from({ length: 12 }, () =>
        request("/api/session-events", "parallel-device", {
          cli: "codex",
          payload,
          checkout,
        }),
      ),
    );
    expect(responses.every((response) => response.ok)).toBe(true);
    const sessions = await (
      await request("/api/device/resources/sessions", "parallel-device")
    ).json<unknown[]>();
    expect(sessions).toHaveLength(1);
  });

  test("keeps device data within the authenticated user", async () => {
    const payload = { session_id: "owned-session", cwd: "/src/example", source: "startup" };
    await request("/api/session-events", "device-a", { cli: "codex", payload, checkout });
    await request("/api/tasks", "device-a", { issue: "MOQ-3" });
    expect((await request("/", "user")).status).toBe(200);
    await expect(
      (await request("/api/device/resources/sessions", "device-b")).json<unknown[]>(),
    ).resolves.toHaveLength(0);
    await expect(
      (await request("/api/device/resources/sessions?all=true", "device-b")).json<unknown[]>(),
    ).resolves.toHaveLength(1);
    await expect(
      (
        await request(
          "/api/device/resources/sessions",
          "other-device",
          undefined,
          undefined,
          "other",
        )
      ).json<unknown[]>(),
    ).resolves.toHaveLength(0);
    await expect(
      (
        await request(
          "/api/device/resources/sessions?global=true",
          "other-device",
          undefined,
          undefined,
          "other",
        )
      ).json<unknown[]>(),
    ).resolves.toHaveLength(0);
    await expect(
      (await request("/api/tasks", "other-device", undefined, undefined, "other")).json<
        unknown[]
      >(),
    ).resolves.toHaveLength(0);
  });

  test("does not update a device owned by another user", async () => {
    expect((await request("/api/health", "shared-device")).status).toBe(200);
    expect(
      (
        await request(
          "/api/health",
          "shared-device",
          undefined,
          undefined,
          "other",
          "tampered-name",
        )
      ).status,
    ).toBe(403);

    const db = drizzle((env as unknown as Env).DB, { schema });
    expect(
      await db
        .select({ name: schema.devices.name })
        .from(schema.devices)
        .where(eq(schema.devices.id, "shared-device"))
        .get(),
    ).toEqual({ name: "shared-device" });
  });

  test("rejects unauthenticated requests", async () => {
    expect((await app.request("/api/tasks", {}, env as unknown as Env)).status).toBe(401);
  });

  test("LOCAL_DEV bypasses authentication only on localhost", async () => {
    const localEnv = { ...(env as unknown as Env), LOCAL_DEV: "true" };
    expect((await app.request("http://localhost/api/tasks", {}, localEnv)).status).toBe(200);
    expect((await app.request("https://wr.example.com/api/tasks", {}, localEnv)).status).toBe(401);
  });
});
