import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { atomic, readPrivateJson, stateHome } from "../../cli/files.js";
import { readRegistration, reapCoordinators, refreshAgentAuthority, refreshCoordinatorEndpoint } from "../../cli/coordination.js";
import { CoordinatorBridge, type ToolContext } from "../../runtime/coordinator.js";
import { NativeRuntimeBridge } from "../../runtime/native.js";
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
type AssignmentReceipt = {
    id: string;
    token: string;
    work: string;
    role: string;
    mode: "read" | "write";
    coordinator: {
        coordinator?: string;
        runtimeAgent?: string;
    } | null;
};
type PendingChild = {
    version: 1;
    assignment: string;
    correlation: string;
    parentRuntimeAgent: string;
    session: string;
    toolId: string;
};
type BoundChild = {
    version: 1;
    bound: boolean;
    externalAgentId: string;
    runtimeAgent: string;
    runtimeRoot: string;
    session: string;
};
const coordinatorDirectory = (bridge: CoordinatorBridge) => dirname(bridge.contextFile);
const pendingChildPath = (bridge: CoordinatorBridge) => join(coordinatorDirectory(bridge), "native-child.pending.json");
const boundChildPath = (bridge: CoordinatorBridge, agentId: string) => join(coordinatorDirectory(bridge), "children", `${digest(agentId)}.json`);
function removeFile(path: string): void {
    try {
        unlinkSync(path);
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
            throw error;
    }
}
function createPendingChild(path: string, pending: PendingChild): void {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    let fd: number;
    try {
        fd = openSync(path, "wx", 0o600);
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            const existing = readPrivateJson<PendingChild>(path);
            demand(existing.assignment === pending.assignment && existing.correlation === pending.correlation && existing.parentRuntimeAgent === pending.parentRuntimeAgent && existing.session === pending.session && existing.toolId === pending.toolId, "NATIVE_SPAWN_BUSY", "Finish the pending native child start before spawning another");
            return;
        }
        throw error;
    }
    let complete = false;
    try {
        writeFileSync(fd, JSON.stringify(pending) + "\n");
        complete = true;
    }
    finally {
        closeSync(fd);
        if (!complete)
            removeFile(path);
    }
}
function childCorrelation(payload: Record<string, unknown>): string | null {
    return typeof payload.prompt_id === "string" && payload.prompt_id ? payload.prompt_id : null;
}
function assignmentReference(input: unknown): string | null {
    if (!input || typeof input !== "object" || Array.isArray(input))
        return null;
    const values = Object.values(input as Record<string, unknown>).filter(value => typeof value === "string") as string[];
    const refs = values.map(value => value.match(/^WR_NEXT_ASSIGNMENT=(del_[0-9a-f-]{36})(?:\r?\n|$)/i)?.[1]).filter((value): value is string => Boolean(value));
    return refs.length === 1 ? refs[0]! : null;
}
function assignmentReceipt(reference: string, bridge: CoordinatorBridge): AssignmentReceipt {
    const receipt = readPrivateJson<AssignmentReceipt>(join(stateHome(), "assignments", `${reference}.json`));
    demand(receipt.id === reference && typeof receipt.token === "string" && typeof receipt.work === "string" && ["read", "write"].includes(receipt.mode), "INVALID_DELEGATION", "Invalid native child assignment receipt");
    demand(receipt.coordinator?.coordinator === bridge.context.coordinator && receipt.coordinator.runtimeAgent === bridge.context.runtimeAgent, "INVALID_DELEGATION", "Assignment was not issued by this Coordinator");
    return receipt;
}
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
function clearPendingTool(bridge: CoordinatorBridge, toolId: unknown): void {
    const path = pendingChildPath(bridge);
    if (!existsSync(path) || typeof toolId !== "string")
        return;
    const pending = readPrivateJson<PendingChild>(path);
    if (pending.toolId === toolId)
        removeFile(path);
}
function prepareClaudeSpawn(bridge: CoordinatorBridge, payload: Record<string, unknown>): void {
    const correlation = childCorrelation(payload);
    demand(correlation, "NATIVE_CORRELATION_UNAVAILABLE", "Claude prompt identity is required to bind a native child");
    demand(typeof payload.tool_use_id === "string", "INVALID_EVENT", "Native spawn tool identity is required");
    const reference = assignmentReference(payload.tool_input);
    demand(reference, "NATIVE_ASSIGNMENT_REQUIRED", "Run wr-next delegate REF --read-only, then put its spawnDirective on the first line of one foreground Agent prompt");
    const receipt = assignmentReceipt(reference, bridge);
    demand(receipt.mode === "read", "NATIVE_READ_ONLY_REQUIRED", "Claude native children currently require wr-next delegate REF --read-only");
    createPendingChild(pendingChildPath(bridge), { version: 1, assignment: reference, correlation, parentRuntimeAgent: bridge.context.runtimeAgent, session: String(payload.session_id), toolId: payload.tool_use_id });
}
async function handleClaudeChildEvent(bridge: CoordinatorBridge, payload: Record<string, unknown>, expected: string): Promise<boolean> {
    const agentId = typeof payload.agent_id === "string" ? payload.agent_id : null;
    if (expected === "SubagentStart") {
        demand(agentId, "INVALID_EVENT", "SubagentStart requires an agent identity");
        const correlation = childCorrelation(payload), pendingPath = pendingChildPath(bridge);
        if (!correlation || !existsSync(pendingPath)) {
            const native = NativeRuntimeBridge.fromCoordinator(bridge.adapter, bridge.context.runtimeAgent);
            const actor = await native.childStarted(bridge.context.runtimeAgent, { externalSessionId: String(payload.session_id), agentId, invocationId: digest({ session: payload.session_id, agentId }) }, digest({ type: "claude-child-observed", session: payload.session_id, agentId }));
            atomic(boundChildPath(bridge, agentId), { version: 1, bound: false, externalAgentId: agentId, runtimeAgent: actor.runtimeAgent, runtimeRoot: actor.runtimeRoot, session: String(payload.session_id) } satisfies BoundChild);
            console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: expected, additionalContext: "wr-next: this native child has no explicit assignment and its tools will be denied. Use wr-next delegate before a foreground Agent call." } }));
            return true;
        }
        const pending = readPrivateJson<PendingChild>(pendingPath);
        demand(pending.version === 1 && pending.correlation === correlation && pending.session === payload.session_id, "NATIVE_CORRELATION_CONFLICT", "SubagentStart does not match the pending native spawn");
        const receipt = assignmentReceipt(pending.assignment, bridge);
        demand(receipt.mode === "read", "NATIVE_READ_ONLY_REQUIRED", "Claude native child assignment must be read-only");
        const native = NativeRuntimeBridge.fromCoordinator(bridge.adapter, bridge.context.runtimeAgent);
        try {
            const actor = await native.childStarted(pending.parentRuntimeAgent, { externalSessionId: String(payload.session_id), agentId, invocationId: digest({ correlation, agentId }) }, digest({ type: "claude-child-start", correlation, agentId }), { delegationToken: receipt.token, environment: bridge.context.environment });
            atomic(boundChildPath(bridge, agentId), { version: 1, bound: true, externalAgentId: agentId, runtimeAgent: actor.runtimeAgent, runtimeRoot: actor.runtimeRoot, session: String(payload.session_id) } satisfies BoundChild);
            removeFile(join(stateHome(), "assignments", `${pending.assignment}.json`));
            console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: expected, additionalContext: await native.resumeContext(actor.runtimeAgent) } }));
        }
        finally {
            removeFile(pendingPath);
        }
        return true;
    }
    if (!agentId)
        return false;
    const path = boundChildPath(bridge, agentId);
    if (!existsSync(path)) {
        if (expected === "PreToolUse")
            console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: expected, permissionDecision: "deny", permissionDecisionReason: "Native child has no explicit wr-next assignment; parent Coordinator state was not inherited." } }));
        return true;
    }
    const child = readPrivateJson<BoundChild>(path);
    demand(child.version === 1 && child.externalAgentId === agentId && child.session === payload.session_id && child.runtimeRoot === bridge.context.runtimeAgent, "RUNTIME_BINDING_CONFLICT", "Native child receipt does not match this Coordinator");
    const native = NativeRuntimeBridge.fromCoordinator(bridge.adapter, bridge.context.runtimeAgent);
    if (expected === "SubagentStop") {
        await native.lifecycle(child.runtimeAgent, "quiescent", digest({ type: "claude-child-stop", agentId, message: payload.last_assistant_message }));
        return true;
    }
    if (!child.bound) {
        if (expected === "PreToolUse")
            console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: expected, permissionDecision: "deny", permissionDecisionReason: "Native child has no explicit wr-next assignment; parent Coordinator state was not inherited." } }));
        return true;
    }
    if (expected === "PreToolUse") {
        if (["Agent", "Task", "SendMessage"].includes(String(payload.tool_name))) {
            console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: expected, permissionDecision: "deny", permissionDecisionReason: "Nested native children and child messaging are not yet bound to dedicated Executions" } }));
            return true;
        }
        if (payload.tool_name === "Bash" || payload.tool_name === "bash") {
            const input = payload.tool_input as Record<string, unknown>;
            demand(input && typeof input.command === "string", "INVALID_EVENT", "Shell command is required");
            if (!managementCommand(input.command)) {
                console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: expected, permissionDecision: "deny", permissionDecisionReason: "Read-only native children may use bounded wr-next and Git inspection commands, not arbitrary shell commands" } }));
                return true;
            }
            const env = await native.toolEnvironment(child.runtimeAgent);
            const command = `export WR_NEXT_CONTEXT=${quote(env.WR_NEXT_CONTEXT!)} WR_NEXT_BINDING_REQUIRED=1 WR_NEXT_RUNTIME_AGENT=${quote(env.WR_NEXT_RUNTIME_AGENT!)}; unset WR_NEXT_COORDINATOR WR_NEXT_COORDINATOR_TOOL WR_NEXT_TOKEN WR_NEXT_RUNTIME_CONNECTION; ${input.command}`;
            console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: expected, updatedInput: { ...input, command } } }));
            return true;
        }
        const readTool = ["Read", "Grep", "Glob", "WebSearch", "WebFetch"].includes(String(payload.tool_name));
        if (!readTool)
            console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: expected, permissionDecision: "deny", permissionDecisionReason: "Read-only native child tool is not in the supported inspection allowlist" } }));
        return true;
    }
    if (expected === "PostToolUse" || expected === "PostToolUseFailure" || expected === "PermissionDenied")
        clearPendingTool(bridge, payload.tool_use_id);
    return true;
}
/** Return true only when this permanent hook is handled by explicit repo coordination. */
export async function coordinatorHook(input: string, source: string, expected: string): Promise<boolean> {
    demand(["claude", "codex", "omp"].includes(source), "UNSUPPORTED_ADAPTER", "Unsupported coordinator runtime", 400);
    const runtime = source as "claude" | "codex" | "omp";
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
    const owner = providerOwner(runtime);
    demand(owner, "RUNTIME_IDENTITY_UNAVAILABLE", "Cannot identify this runtime invocation. Use wr-next run --next or a native dispatcher; no session-only guess was made");
    const key = digest({ root, source: runtime, session: payload.session_id, owner }), ownerFile = join(stateHome(), "coordinator-owners", `${key}.json`);
    requireInstalled(root, runtime);
    registration = await refreshAgentAuthority(registration);
    if (!existsSync(ownerFile) && (expected !== "SessionStart" || payload.source === "compact")) {
        demand(expected !== "PreToolUse", "COORDINATOR_NOT_ACTIVE", "No root bootstrap receipt. Restart the runtime after approving the repository integration");
        return true;
    }
    let bridge: CoordinatorBridge;
    if (!existsSync(ownerFile)) {
        await reapCoordinators(stateHome(), registration);
        bridge = await CoordinatorBridge.open(registration.bootstrap, { runtime, session: payload.session_id, actor: "root", invocation: digest({ owner, session: payload.session_id }), environment: registration.environment });
        atomic(ownerFile, { ...owner, controller: join(bridge.contextFile, "..", "controller.json"), session: payload.session_id, root } satisfies Owner);
    }
    else {
        const record = readPrivateJson<Owner>(ownerFile);
        demand(!record.ended && record.identity === owner.identity && record.session === payload.session_id && record.root === root, "STALE_COORDINATOR", "Recorded runtime has ended or no longer matches");
        bridge = CoordinatorBridge.restore(record.controller);
        refreshCoordinatorEndpoint(bridge, registration);
    }
    if (payload.agent_id || expected === "SubagentStart" || expected === "SubagentStop") {
        if (runtime === "claude")
            return await handleClaudeChildEvent(bridge, payload, expected);
        if (expected === "PreToolUse")
            console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: expected, permissionDecision: "deny", permissionDecisionReason: `${runtime} child tool events do not expose a verified actor binding; parent state was not used.` } }));
        else if (expected === "SubagentStart")
            console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: expected, additionalContext: `wr-next: ${runtime} native children remain unbound because their tool events lack a verified child identity.` } }));
        return true;
    }
    if (expected === "SessionStart" || expected === "PostCompact") {
        if (payload.source === "compact" || expected === "PostCompact")
            await bridge.window(typeof payload.event_id === "string" ? payload.event_id : uid("window"));
        console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: expected, additionalContext: await bridge.guidance() } }));
        return true;
    }
    if (expected === "PreToolUse") {
        const nativeTools: Record<typeof runtime, string[]> = {
            claude: ["Agent", "Task", "SendMessage"],
            codex: ["spawn_agent", "Agent", "send_input", "resume_agent", "close_agent"],
            omp: ["task", "Task", "Agent", "spawn_agent"],
        };
        const nativeTool = nativeTools[runtime].includes(payload.tool_name);
        const supportedNativeSpawn = runtime === "claude" && ["Agent", "Task"].includes(payload.tool_name);
        const input = payload.tool_input ?? {};
        if (nativeTool && !supportedNativeSpawn || input.run_in_background === true) {
            console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: expected, permissionDecision: "deny", permissionDecisionReason: nativeTool ? `${runtime} native dispatch lacks the host identities required for safe binding.` : "Background writers are not supported by this coordinator profile." } }));
            return true;
        }
        if (supportedNativeSpawn) {
            try {
                prepareClaudeSpawn(bridge, payload);
            }
            catch (error) {
                console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: expected, permissionDecision: "deny", permissionDecisionReason: error instanceof Error ? error.message : String(error) } }));
                return true;
            }
        }
        const state = await new Client(bridge.context).request<any>("/v1/coordination");
        const canRead = ["Read", "read", "Grep", "grep", "Glob", "glob", "WebSearch", "web_search", "WebFetch", "web_fetch"].includes(payload.tool_name);
        const shell = payload.tool_name === "Bash" || payload.tool_name === "bash";
        const deniedUnclaimed = !state.currentExecution && !canRead && !supportedNativeSpawn && !(shell && typeof input.command === "string" && managementCommand(input.command));
        if (deniedUnclaimed) {
            console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: expected, permissionDecision: "deny", permissionDecisionReason: "Claim work before implementation. Use a separate wr-next next --claim tool call." } }));
            return true;
        }
        demand(typeof payload.tool_use_id === "string", "INVALID_EVENT", "Tool identity is required for stable assignment");
        let env: NodeJS.ProcessEnv;
        try {
            env = await bridge.toolEnvironment(payload.tool_use_id, { tool: payload.tool_name, input });
        }
        catch (error) {
            if (supportedNativeSpawn)
                clearPendingTool(bridge, payload.tool_use_id);
            throw error;
        }
        if (shell) {
            demand(typeof input.command === "string", "INVALID_EVENT", "Shell command is required");
            const command = `export WR_NEXT_COORDINATOR=${quote(env.WR_NEXT_COORDINATOR!)} WR_NEXT_COORDINATOR_TOOL=${quote(env.WR_NEXT_COORDINATOR_TOOL!)}; unset WR_NEXT_CONTEXT WR_NEXT_BINDING_REQUIRED WR_NEXT_RUNTIME_AGENT WR_NEXT_RUNTIME_CONNECTION; ${input.command}`;
            const output: Record<string, unknown> = { hookEventName: expected, updatedInput: { ...input, command } };
            // Codex requires this control marker for rewrites; core sandbox and approval still evaluate the rewritten command.
            if (runtime === "codex")
                output.permissionDecision = "allow";
            console.log(JSON.stringify({ hookSpecificOutput: output }));
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
            clearPendingTool(bridge, id);
        for (const id of new Set(ids))
            if (existsSync(bridge.toolPath(id)))
                await bridge.toolFinished(id);
        return true;
    }
    if (expected === "PermissionDenied") {
        clearPendingTool(bridge, payload.tool_use_id);
        if (typeof payload.tool_use_id === "string" && existsSync(bridge.toolPath(payload.tool_use_id)))
            await bridge.toolFinished(payload.tool_use_id);
        return true;
    }
    if (expected === "PostToolUse" || expected === "PostToolUseFailure") {
        clearPendingTool(bridge, payload.tool_use_id);
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
    if (expected === "SessionEnd") {
        removeFile(pendingChildPath(bridge));
        await bridge.stop(false);
    }
    return true;
}
/** Diagnostic only: callers never get credentials through this summary. */
export function localCoordinatorCount(): number {
    const path = join(stateHome(), "coordinator-owners");
    return existsSync(path) ? readdirSync(path).filter(n => n.endsWith(".json")).length : 0;
}
