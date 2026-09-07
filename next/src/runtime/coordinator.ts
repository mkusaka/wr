import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "../cli/client.js";
import { atomic, readPrivateJson, coordinatorTool, stateHome, type Connection, type ContextFile } from "../cli/files.js";
import { capabilityConnection, type ExecutionBinding } from "./binding.js";
import { demand, digest, uid } from "../domain/util.js";
export type CoordinatorContext = Connection & {
    coordinator: string;
    runtimeAgent: string;
    run: string;
    work: string;
    environment: string;
    runtime: string;
};
export type ToolContext = {
    version: 1;
    coordinator: CoordinatorContext;
    dispatch: string;
    worker: ContextFile | null;
};
type Credentials = {
    result: Record<string, any>;
    binding?: ExecutionBinding | null;
    capabilities: Record<string, string>;
};
/** Trusted harness-side controller. Its runtime/adapter credentials are NOT model context. */
export class CoordinatorBridge {
    constructor(readonly contextFile: string, readonly context: CoordinatorContext, readonly observer: Connection, readonly adapter: Connection) { }
    static async open(bootstrap: Connection, identity: {
        runtime: string;
        session: string;
        actor: string;
        invocation: string;
        environment: string;
    }, home = stateHome()): Promise<CoordinatorBridge> {
        const result = await new Client(bootstrap).command<Credentials>({ type: "coordination.open", ...identity }, { id: digest({ type: "coordination.open", ...identity }) });
        const dir = join(home, "coordinators", result.result.coordinator);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const context: CoordinatorContext = { ...capabilityConnection(bootstrap, result.capabilities.coordinator!), coordinator: result.result.coordinator, runtimeAgent: result.result.runtimeAgent, run: result.result.run, work: result.result.work, environment: identity.environment, runtime: identity.runtime };
        const observer = capabilityConnection(bootstrap, result.capabilities.runtime!), adapter = capabilityConnection(bootstrap, result.capabilities.adapter!);
        atomic(join(dir, "context.json"), context);
        atomic(join(dir, "controller.json"), { context, observer, adapter });
        return new CoordinatorBridge(join(dir, "context.json"), context, observer, adapter);
    }
    static restore(path: string): CoordinatorBridge {
        const record = readPrivateJson<{
            context: CoordinatorContext;
            observer: Connection;
            adapter: Connection;
        }>(path);
        return new CoordinatorBridge(join(path, "..", "context.json"), record.context, record.observer, record.adapter);
    }
    async toolEnvironment(toolId: string, input: unknown, base: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv> {
        const response = await new Client(this.observer).command<Credentials>({ type: "coordination.dispatch", toolId, inputDigest: digest(input) }, { id: digest({ type: "dispatch", coordinator: this.context.coordinator, toolId, input: digest(input) }) });
        const file = this.toolPath(toolId);
        saveToolContext(file, this.context, response);
        const env = { ...base };
        for (const key of ["WR_NEXT_CONTEXT", "WR_NEXT_BINDING_REQUIRED", "WR_NEXT_RUNTIME_AGENT", "WR_NEXT_RUNTIME_ROOT", "WR_NEXT_RUNTIME_CONNECTION", "WR_NEXT_TOKEN", "WR_NEXT_SERVER", "WR_NEXT_COORDINATOR", "WR_NEXT_COORDINATOR_TOOL"])
            delete env[key];
        env.WR_NEXT_COORDINATOR = this.contextFile;
        env.WR_NEXT_COORDINATOR_TOOL = file;
        env.WR_NEXT_RUNTIME_KIND = this.context.runtime;
        return env;
    }
    toolPath(toolId: string): string { return join(this.contextFile, "..", "tools", `${digest({ toolId })}.json`); }
    async toolFinished(toolId: string): Promise<void> {
        const path = this.toolPath(toolId);
        demand(existsSync(path), "UNKNOWN_TOOL", "Cannot close an unobserved tool");
        const slot = readPrivateJson<ToolContext>(path);
        await new Client(this.observer).command({ type: "coordination.dispatch.close", dispatch: slot.dispatch }, { id: digest({ type: "close", coordinator: this.context.coordinator, dispatch: slot.dispatch }) });
        // Preserve the old immutable assignment on disk; never replace it with the next work.
    }
    async window(id: string): Promise<void> { await new Client(this.observer).command({ type: "coordination.window", window: id }, { id: digest({ coordinator: this.context.coordinator, window: id }) }); }
    async stop(processStopped = false): Promise<void> { await new Client(this.observer).command({ type: "coordination.stop", processStopped }, { id: digest({ coordinator: this.context.coordinator, stopped: processStopped }) }); }
    async guidance(): Promise<string> {
        const state = await new Client(this.context).request<any>("/v1/coordination");
        return [
            `You coordinate work within ${state.title}. No implementation work is assigned merely by session start.`,
            "Interpret the user's request, inspect wr-next status/ready, and create or adjust a small plan using wr-next add or wr-next plan --changes. Do not ask the user to manage Work IDs.",
            "Use wr-next claim <ref> for a deliberate choice, or wr-next next --claim for deterministic ready selection. Never choose unrelated backlog just because it is ready. Empty ready means create relevant work or explain its blockers, not completion.",
            "After claim, use wr-next report for decisions/blockers and wr-next done --summary to submit. Completion is policy checked. Submit/yield in a separate tool call; the next tool sees the new assignment. Do not keep background writers across handoff.",
            this.context.runtime === "claude" ? "A read-only foreground Claude child requires an explicit assignment: run wr-next delegate REF --read-only, then put the returned spawnDirective on the first line of exactly one Agent prompt. Nested/background children are denied." : "Native subagents are not safely bindable from this runtime's current hook surface; use explicit delegated runs. Never reuse this root's context.",
            state.currentExecution ? "A current work attempt exists. Read status before continuing; old prose is not evidence of current completion." : "No current work. You may inspect and plan; claim before editing files.",
        ].join("\n");
    }
}
export function saveToolContext(path: string, co: CoordinatorContext, response: Credentials): void {
    demand(response.result.coordinator === co.coordinator, "UNBOUND_COORDINATOR", "Response belongs to another runtime");
    let worker: ContextFile | null = null;
    if (response.binding && response.capabilities.worker) {
        const b = response.binding;
        worker = { ...capabilityConnection(co, response.capabilities.worker), ...b, operationScope: response.result.dispatch, dispatch: response.result.dispatch, effectToken: response.capabilities.effect, gitToken: response.capabilities.git!, githubToken: response.capabilities.github, contributors: [] };
    }
    atomic(path, { version: 1, coordinator: { ...co, token: response.capabilities.coordinator!, operationScope: response.result.dispatch }, dispatch: response.result.dispatch, worker } satisfies ToolContext);
}
/** Claim response is written to THIS tool only; old shells retain their previous assignment. */
export async function claimCurrentTool(work?: string, retry = false, reason?: string): Promise<unknown> {
    const path = process.env.WR_NEXT_COORDINATOR_TOOL;
    demand(path, "UNBOUND_COORDINATOR", "Claim must run through a bound runtime tool; use the installed integration", 403);
    const slot = coordinatorTool();
    demand(slot, "UNBOUND_COORDINATOR", "Tool context required");
    const command = { type: "work.claim", work, retry, reason };
    const receipt = `${path}.claim.json`;
    const request = existsSync(receipt) ? readPrivateJson<{
        id: string;
        digest: string;
    }>(receipt) : { id: uid("claim"), digest: digest(command) };
    demand(request.digest === digest(command), "OPERATION_CONFLICT", "A different claim already occurred in this tool; start another tool call");
    atomic(receipt, request);
    const response = await new Client(slot.coordinator).command<Credentials>(command, { id: request.id });
    saveToolContext(path, slot.coordinator, response);
    return { ...response.result, ...(response.binding ? { title: (await new Client({ ...slot.coordinator, token: response.capabilities.coordinator! }).request<any>(`/v1/work?work=${encodeURIComponent(response.binding.work)}`)).work.title } : {}) };
}
/** No credential is returned by the ordinary selection/report CLI. */
export function toolCoordinator(path = process.env.WR_NEXT_COORDINATOR_TOOL): CoordinatorContext | null {
    return path ? readPrivateJson<ToolContext>(path).coordinator : null;
}
