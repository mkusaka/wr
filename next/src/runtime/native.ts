import { join, resolve, dirname } from "node:path";
import { lstatSync } from "node:fs";
import { Client } from "../cli/client.js";
import { atomic, readJson, stateHome, type Connection, type ContextFile } from "../cli/files.js";
import { demand, digest, uid } from "../domain/util.js";
/** Supplied by the harness, never inferred from cwd, prompt text, or the latest child. */
export type NativeIdentity = {
    externalSessionId: string;
    agentId: string;
    invocationId: string;
};
export type NativeRoot = NativeIdentity & {
    work?: string;
    runtime: string;
    environment?: string;
    role?: "orchestrator" | "implementer" | "reviewer" | "validator" | "integrator";
    mode?: "read" | "write";
    continuedFrom?: string;
};
type Binding = {
    execution: string;
    run: string;
    work: string;
    key: string;
    scopeRevision: number;
    generation: number;
    environment: string;
    runtimeAgent: string;
    runtimeRoot: string;
};
type BoundResponse = {
    result: Binding;
    capabilities: {
        worker: string;
        launcher: string;
        git: string;
        github: string;
        adapter?: string;
    };
};
export type NativeActor = {
    runtimeAgent: string;
    runtimeRoot: string;
    execution: string | null;
};
/**
 * Trusted harness-side broker. Keep it outside model tool arguments/environment.
 * A native scheduler calls childStarted with the exact spawn -> work association;
 * a per-tool dispatcher calls toolEnvironment with its authenticated actor identity.
 * This implements no provider-specific spawn API and makes no native-support claim.
 */
export class NativeRuntimeBridge {
    private readonly client: Client;
    private constructor(private readonly cfg: Connection, readonly root: string, private readonly directory: string) {
        this.client = new Client(cfg);
    }
    static async attach(cfg: Connection, root: NativeRoot, operationId: string, directory = join(stateHome(), "native")): Promise<NativeRuntimeBridge> {
        const response = await new Client(cfg).command<BoundResponse>({ type: "runtime.attach", ...root }, { id: operationId });
        demand(response.capabilities.adapter, "UNBOUND_RUNTIME_ACTOR", "Runtime root did not receive adapter authority");
        const adapterCfg = { ...cfg, ...transport(cfg), token: response.capabilities.adapter };
        const bridge = new NativeRuntimeBridge(adapterCfg, response.result.runtimeRoot, resolve(directory));
        // A separate private broker receipt is not a worker context. It can be explicitly
        // reopened by the same harness after a broker crash without starting another Run.
        atomic(join(bridge.directory, response.result.runtimeRoot, "broker.json"), { version: 1, root: bridge.root, connection: adapterCfg });
        return bridge;
    }
    static async restore(receipt: string): Promise<NativeRuntimeBridge> {
        const st = lstatSync(receipt);
        demand(st.isFile() && !st.isSymbolicLink() && (st.mode & 0o077) === 0 && (!process.getuid || st.uid === process.getuid()), "UNSAFE_CONTEXT", "Broker receipt must be owner-private");
        const saved = readJson<{
            version: number;
            root: string;
            connection: Connection;
        }>(receipt);
        demand(saved.version === 1 && typeof saved.root === "string", "UNSAFE_CONTEXT", "Invalid broker receipt");
        // Authenticate against persisted root/generation before using any saved authority.
        const graph = await new Client(saved.connection).request<{
            nodes: {
                id: string;
            }[];
        }>("/v1/runtime");
        demand(graph.nodes.some(n => n.id === saved.root), "UNBOUND_RUNTIME_ACTOR", "Broker receipt has no matching runtime root");
        return new NativeRuntimeBridge(saved.connection, saved.root, dirname(dirname(resolve(receipt))));
    }
    async childStarted(parent: string, child: NativeIdentity, operationId: string, assignment?: {
        delegationToken: string;
        environment: string;
    }): Promise<NativeActor> {
        // Native creation is an observed fact, independent of permission to claim work.
        // Retain an unassigned actor even when binding fails (not-ready, stale or revoked).
        const response = await this.client.command<{
            result: NativeActor;
        }>({ type: "runtime.child", parent, ...child }, { id: digest({ operationId, phase: "observed" }) });
        if (assignment)
            return this.bind(response.result.runtimeAgent, assignment.delegationToken, assignment.environment, digest({ operationId, phase: "bind" }));
        return { runtimeAgent: response.result.runtimeAgent, runtimeRoot: response.result.runtimeRoot, execution: response.result.execution };
    }
    async bind(agent: string, delegationToken: string, environment: string, operationId: string): Promise<NativeActor> {
        const response = await this.client.command<BoundResponse>({ type: "runtime.bind", agent, delegationToken, environment }, { id: operationId });
        return { runtimeAgent: response.result.runtimeAgent, runtimeRoot: response.result.runtimeRoot, execution: response.result.execution };
    }
    async lifecycle(agent: string, event: "started" | "heartbeat" | "window" | "quiescent" | "unknown" | "ended", eventId: string, details: {
        windowId?: string;
        exitCode?: number;
        sequence?: number;
    } = {}): Promise<void> {
        // A model Stop is quiescent. Only the harness, after tools/processes have stopped,
        // reports ended. No descendant is ended by a parent's observation.
        await this.client.command({ type: "runtime.lifecycle", agent, event, ...details }, { id: eventId, observed: true, queue: true });
    }
    async toolEnvironment(agent: string, base: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv> {
        const env = unboundToolEnvironment(base);
        const response = await this.client.command<BoundResponse>({ type: "runtime.credentials", agent });
        const binding = response.result;
        demand(binding.runtimeAgent === agent && binding.runtimeRoot === this.root, "RUNTIME_BINDING_CONFLICT", "Authority returned another runtime identity");
        const path = join(this.directory, this.root, "contexts", digest(agent), `${uid("tool")}.json`);
        const ctx: ContextFile = { ...this.cfg, ...binding, token: response.capabilities.worker, gitToken: response.capabilities.git, launcherToken: response.capabilities.launcher, githubToken: response.capabilities.github, contributors: [] };
        atomic(path, ctx);
        // No operator credential, parent context, global current-work state, or broker
        // capability is passed to the subprocess. Each tool gets an immutable context file.
        return { ...env, WR_NEXT_CONTEXT: path, WR_NEXT_RUNTIME_AGENT: agent };
    }
}
function transport(cfg: Connection): Partial<Connection> {
    return !cfg.accessToken && !cfg.token.startsWith("wn1.") && cfg.token.split(".").length === 3 ? { accessToken: cfg.token } : {};
}
/** The harness MUST use this for any native tool lacking a verified work assignment. */
export function unboundToolEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const env = { ...base };
    for (const key of Object.keys(env))
        if (key.startsWith("WR_NEXT_") && key !== "WR_NEXT_HOME" || ["WR_SESSION_RUN_ID", "WR_CLI_SESSION", "WR_EXECUTION_ID", "WR_PARENT_CLI_SESSION"].includes(key))
            delete env[key];
    env.WR_NEXT_BINDING_REQUIRED = "1";
    return env;
}
