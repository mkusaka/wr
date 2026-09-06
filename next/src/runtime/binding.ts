import { atomic, type Connection, type ContextFile } from "../cli/files.js";
export type ExecutionBinding = {
    execution: string;
    run: string;
    work: string;
    key: string;
    scopeRevision: number;
    generation: number;
    environment: string;
    runtimeAgent?: string;
    runtimeRoot?: string;
};
export type WorkCapabilities = {
    worker: string;
    launcher: string;
    git: string;
    github: string;
};
/** Whitelist transport fields. Never spread an operator config into a worker file. */
export function capabilityConnection(cfg: Connection, token: string): Connection {
    const accessToken = cfg.accessToken ?? (!cfg.token.startsWith("wn1.") && cfg.token.split(".").length === 3 ? cfg.token : undefined);
    return { server: cfg.server, workspace: cfg.workspace, device: cfg.device, token, ...(accessToken ? { accessToken } : {}) };
}
/** Shared by managed processes and trusted native per-tool dispatchers. */
export function writeExecutionContext(path: string, cfg: Connection, binding: ExecutionBinding, capabilities: WorkCapabilities, integration?: ContextFile["integration"]): ContextFile {
    const ctx: ContextFile = {
        ...capabilityConnection(cfg, capabilities.worker),
        work: binding.work, key: binding.key, execution: binding.execution, run: binding.run,
        scopeRevision: binding.scopeRevision, generation: binding.generation, environment: binding.environment,
        gitToken: capabilities.git, launcherToken: capabilities.launcher, githubToken: capabilities.github,
        contributors: [],
        ...(binding.runtimeAgent ? { runtimeAgent: binding.runtimeAgent } : {}),
        ...(binding.runtimeRoot ? { runtimeRoot: binding.runtimeRoot } : {}),
        ...(integration ? { integration } : {}),
    };
    atomic(path, ctx);
    return ctx;
}
