import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

type SessionContext = {
  cwd: string;
  sessionManager: { getSessionId(): string };
};

function outputText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        part.type === "text" &&
        "text" in part &&
        typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("\n");
}

async function notifyWr(
  action: "session-event" | "session-prompt" | "session-end" | "tool-event",
  ctx: SessionContext,
  payload: Record<string, unknown>,
): Promise<void> {
  const sessionId = ctx.sessionManager.getSessionId();
  const process = Bun.spawn(["wr", "internal", action, "--cli", "pi"], {
    cwd: ctx.cwd,
    env: { ...Bun.env, PI_SESSION_ID: sessionId },
    stdin: "pipe",
    stdout: "ignore",
    stderr: "ignore",
  });
  process.stdin.write(JSON.stringify({ ...payload, session_id: sessionId, cwd: ctx.cwd }));
  process.stdin.end();
  await process.exited;
}

export default function (pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    await notifyWr("session-event", ctx, { source: "startup" });
  });

  pi.on("before_agent_start", async (event, ctx) => {
    await notifyWr("session-prompt", ctx, { prompt: event.prompt });
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    await notifyWr("session-end", ctx, {});
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;
    return {
      input: {
        ...event.input,
        env: {
          ...(event.input.env as Record<string, string> | undefined),
          PI_SESSION_ID: ctx.sessionManager.getSessionId(),
        },
      },
    };
  });

  pi.on("tool_result", async (event, ctx) => {
    const command = event.input.command;
    if (
      event.toolName !== "bash" ||
      typeof command !== "string" ||
      !/\bgh\s+pr\s+(?:create|merge)\b/.test(command)
    )
      return;
    await notifyWr("tool-event", ctx, {
      tool_name: event.toolName,
      tool_input: event.input,
      tool_response: { output: outputText(event.content) },
    });
  });
}
