import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import { atomic, readPrivateJson, stateHome } from "../../cli/files.js";
import { readRegistration, reapCoordinators, refreshAgentAuthority, refreshCoordinatorEndpoint } from "../../cli/coordination.js";
import { CoordinatorBridge, type ToolContext } from "../../runtime/coordinator.js";
import { processIdentity } from "../../runtime/process.js";
import { projectRoot, requireInstalled } from "../runtime-config/project.js";
import { digest, demand, uid } from "../../domain/util.js";
import { Client, syncOutbox } from "../../cli/client.js";
type Owner = {
    pid: number;
    identity: string;
    controller: string;
    session: string;
    root: string;
    ended?: boolean;
};
/** This identifies an already known runtime process, not its work. Work is never inferred from cwd/PID. */
export function providerOwner(runtime: string): {
    pid: number;
    identity: string;
} | null {
    let pid = process.ppid;
    for (let depth = 0; pid > 1 && depth < 24; depth++) {
        try {
            let parent: number, argv: string[];
            if (process.platform === "linux") {
                const stat = readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /, "").split(" ");
                parent = Number(stat[1]);
                argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
            }
            else {
                const row = spawnSync("ps", ["-p", String(pid), "-o", "ppid=", "-o", "command="], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
                const match = row.stdout.trim().match(/^(\d+)\s+(.+)$/);
                if (!match)
                    return null;
                parent = Number(match[1]);
                argv = match[2]!.split(/\s+/);
            }
            const names = argv.slice(0, 2);
            const matched = names.some(value => basename(value) === runtime || runtime === "claude" && /\/@anthropic-ai\/claude-code\/cli\.js$/.test(value));
            if (matched) {
                const identity = processIdentity(pid);
                return identity ? { pid, identity } : null;
            }
            pid = parent;
        }
        catch {
            return null;
        }
    }
    return null;
}
const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
/** Single, non-expanding shell command; quoted JSON remains usable for atomic plan batches. */
export function managementCommand(input: string): boolean {
    const words: string[] = [];
    let word = "", state: "plain" | "single" | "double" = "plain";
    for (let i = 0; i < input.length; i++) {
        const c = input[i]!;
        if (state === "single") {
            if (c === "'")
                state = "plain";
            else
                word += c;
            continue;
        }
        if (state === "double") {
            if (c === '"') {
                state = "plain";
                continue;
            }
            if (c === "$" || c === "`")
                return false;
            if (c === "\\") {
                word += input[++i] ?? "";
                continue;
            }
            word += c;
            continue;
        }
        if (c === "'") {
            state = "single";
            continue;
        }
        if (c === '"') {
            state = "double";
            continue;
        }
        if (/[;&|<>\n\r$`()\\]/.test(c))
            return false;
        if (/\s/.test(c)) {
            if (word)
                words.push(word);
            word = "";
        }
        else
            word += c;
    }
    if (state !== "plain")
        return false;
    if (word)
        words.push(word);
    if (words[0] === "wr-next")
        return ["status", "ready", "next", "claim", "add", "plan", "report", "done", "yield", "delegate", "agents", "graph", "help", "cancel", "hold"].includes(words[1] ?? "");
    if (words[0] === "pwd" && words.length === 1)
        return true;
    if (words[0] === "git")
        return ["status", "diff", "log", "show"].includes(words[1] ?? "") && !words.some(w => /^(--output|--ext-diff|--textconv|--exec|--config|--upload-pack)/.test(w));
    return false;
}
/** Return true only when this permanent hook is handled by explicit repo coordination. */
export async function coordinatorHook(input: string, source: string, expected: string): Promise<boolean> {
    if (source !== "claude")
        return false; // Other profiles use the trusted bridge or ID-free run --next.
    const payload = JSON.parse(input) as Record<string, any>;
    demand(payload && payload.hook_event_name === expected, "INVALID_EVENT", "Hook event mismatch", 400);
    if (typeof payload.cwd !== "string" || typeof payload.session_id !== "string")
        return false;
    let root: string;
    try {
        root = projectRoot(payload.cwd);
    }
    catch {
        return false;
    }
    let registration = readRegistration(root);
    if (!registration)
        return false;
    if (process.env.WR_NEXT_COORDINATOR || process.env.WR_NEXT_COORDINATOR_TOOL) {
        if (expected === "PreToolUse")
            console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: expected, permissionDecision: "deny", permissionDecisionReason: "A descendant process cannot inherit a repository Coordinator grant. Use explicit child delegation." } }));
        return true;
    }
    const owner = providerOwner(source);
    demand(owner, "RUNTIME_IDENTITY_UNAVAILABLE", "Cannot identify this runtime invocation. Use wr-next run --next or a native dispatcher; no session-only guess was made");
    const key = digest({ root, source, session: payload.session_id, owner }), ownerFile = join(stateHome(), "coordinator-owners", `${key}.json`);
    requireInstalled(root, "claude");
    // Never bootstrap an inherited native child as a new repository coordinator.
    if (payload.agent_id || expected === "SubagentStart" || expected === "SubagentStop") {
        if (expected === "PreToolUse")
            console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: expected, permissionDecision: "deny", permissionDecisionReason: "Native child has no dedicated coordinator/Execution binding. Use the trusted bridge; parent state was not used." } }));
        return true;
    }
    registration = await refreshAgentAuthority(registration);
    if (!existsSync(ownerFile) && (expected !== "SessionStart" || payload.source === "compact")) {
        demand(expected !== "PreToolUse", "COORDINATOR_NOT_ACTIVE", "No root bootstrap receipt. Restart the runtime after approving the repository integration");
        return true;
    }
    let bridge: CoordinatorBridge;
    if (!existsSync(ownerFile)) {
        await reapCoordinators(stateHome(), registration);
        bridge = await CoordinatorBridge.open(registration.bootstrap, { runtime: source, session: payload.session_id, actor: "root", invocation: digest({ owner, session: payload.session_id }), environment: registration.environment });
        atomic(ownerFile, { ...owner, controller: join(bridge.contextFile, "..", "controller.json"), session: payload.session_id, root } satisfies Owner);
    }
    else {
        const record = readPrivateJson<Owner>(ownerFile);
        demand(!record.ended && record.identity === owner.identity && record.session === payload.session_id && record.root === root, "STALE_COORDINATOR", "Recorded runtime has ended or no longer matches");
        bridge = CoordinatorBridge.restore(record.controller);
        refreshCoordinatorEndpoint(bridge, registration);
    }
    if (expected === "SessionStart" || expected === "PostCompact") {
        if (payload.source === "compact" || expected === "PostCompact")
            await bridge.window(typeof payload.event_id === "string" ? payload.event_id : uid("window"));
        console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: expected, additionalContext: await bridge.guidance() } }));
        return true;
    }
    if (expected === "PreToolUse") {
        const deniedNative = ["Agent", "Task", "SendMessage"].includes(payload.tool_name);
        const state = await new Client(bridge.context).request<any>("/v1/coordination");
        const canRead = ["Read", "Grep", "Glob", "WebSearch", "WebFetch"].includes(payload.tool_name);
        const input = payload.tool_input ?? {};
        const deniedUnclaimed = !state.currentExecution && !canRead && !(payload.tool_name === "Bash" && typeof input.command === "string" && managementCommand(input.command));
        if (deniedNative || deniedUnclaimed || input.run_in_background === true) {
            console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: expected, permissionDecision: "deny", permissionDecisionReason: deniedNative ? "Native dispatch requires a dedicated child binding; use the harness bridge or explicit delegation." : "Claim work before implementation. Use a separate wr-next next --claim tool call; background writers are not supported by this coordinator profile." } }));
            return true;
        }
        demand(typeof payload.tool_use_id === "string", "INVALID_EVENT", "Tool identity is required for stable assignment");
        const env = await bridge.toolEnvironment(payload.tool_use_id, { tool: payload.tool_name, input });
        if (payload.tool_name === "Bash") {
            demand(typeof input.command === "string", "INVALID_EVENT", "Bash command is required");
            const command = `export WR_NEXT_COORDINATOR=${quote(env.WR_NEXT_COORDINATOR!)} WR_NEXT_COORDINATOR_TOOL=${quote(env.WR_NEXT_COORDINATOR_TOOL!)}; unset WR_NEXT_CONTEXT WR_NEXT_BINDING_REQUIRED WR_NEXT_RUNTIME_AGENT WR_NEXT_RUNTIME_CONNECTION; ${input.command}`;
            // Deliberately omit permissionDecision=allow: normal Claude permissions still apply.
            console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: expected, updatedInput: { ...input, command } } }));
        }
        return true;
    }
    if (expected === "PostToolBatch") {
        demand(Array.isArray(payload.tool_calls) && payload.tool_calls.length <= 512, "INVALID_EVENT", "Bounded resolved tool batch required");
        const ids = payload.tool_calls.map((item: unknown) => {
            const id = (item as {
                tool_use_id?: unknown;
            } | null)?.tool_use_id;
            demand(typeof id === "string" && id.length > 0 && id.length <= 300, "INVALID_EVENT", "Resolved batch requires exact tool identities");
            return id;
        });
        // Only explicit resolved IDs, never all pending tools nor a timeout heuristic.
        // A result or a permission denial is not a work completion assertion.
        for (const id of new Set(ids))
            if (existsSync(bridge.toolPath(id)))
                await bridge.toolFinished(id);
        return true;
    }
    if (expected === "PermissionDenied") {
        if (typeof payload.tool_use_id === "string" && existsSync(bridge.toolPath(payload.tool_use_id)))
            await bridge.toolFinished(payload.tool_use_id);
        return true;
    }
    if (expected === "PostToolUse" || expected === "PostToolUseFailure") {
        if (typeof payload.tool_use_id !== "string" || !existsSync(bridge.toolPath(payload.tool_use_id)))
            return true;
        const slot = readPrivateJson<ToolContext>(bridge.toolPath(payload.tool_use_id));
        // Flush Git observations while this exact work epoch is still active.
        await syncOutbox();
        if (expected === "PostToolUse" && slot.worker && /\bgh\s+pr\s+(create|merge)\b/.test(String(payload.tool_input?.command ?? ""))) {
            const response = payload.tool_response, output = typeof response === "string" ? response : response?.stdout ?? response?.output ?? "";
            const urls = typeof output === "string" ? [...new Set(output.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g) ?? [])] : [];
            if (urls.length === 1 && response?.is_error !== true) {
                const pieces = new URL(urls[0]!).pathname.split("/");
                const { syncPr } = await import("../github.js");
                try {
                    await syncPr(slot.worker, `${pieces[1]}/${pieces[2]}`, Number(pieces[4]));
                }
                catch { /* Never hold a completed tool open on network-only PR observation. */ }
            }
        }
        await bridge.toolFinished(payload.tool_use_id);
        return true;
    }
    if (expected === "SessionEnd")
        await bridge.stop(false);
    return true;
}
/** Diagnostic only: callers never get credentials through this summary. */
export function localCoordinatorCount(): number {
    const path = join(stateHome(), "coordinator-owners");
    return existsSync(path) ? readdirSync(path).filter(n => n.endsWith(".json")).length : 0;
}
