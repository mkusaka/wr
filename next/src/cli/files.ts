import { mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, readFileSync, existsSync, chmodSync, lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { demand } from "../domain/util.js";
export function stateHome(): string { return process.env.WR_NEXT_HOME ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "wr-next"); }
export function atomic(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    demand(!existsSync(path) || !lstatSync(path).isSymbolicLink(), "UNSAFE_PATH", "Refusing symbolic-link state file");
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    const fd = openSync(tmp, "wx", 0o600);
    try {
        writeFileSync(fd, JSON.stringify(value, null, 2) + "\n");
        fsyncSync(fd);
    }
    finally {
        closeSync(fd);
    }
    renameSync(tmp, path);
    chmodSync(path, 0o600);
    const dir = openSync(dirname(path), "r");
    try {
        fsyncSync(dir);
    }
    finally {
        closeSync(dir);
    }
}
export function readJson<T>(path: string): T { return JSON.parse(readFileSync(path, "utf8")) as T; }
export type Connection = {
    localAuthority?: {
        database: string;
        pid: number;
        processIdentity: string | null;
    };
    server: string;
    workspace: string;
    device: string;
    token: string;
    accessToken?: string;
    operationScope?: string;
};
export type ContextFile = Connection & {
    integration?: {
        runtime: string;
        mode: "project" | "isolated";
        adapterVersion: number;
        root: string;
    };
    work: string;
    key: string;
    execution: string;
    run: string;
    scopeRevision: number;
    generation: number;
    environment: string;
    gitToken: string;
    contributors: string[];
    launcherToken?: string;
    effectToken?: string;
    dispatch?: string;
    githubToken?: string;
    runtimeAgent?: string;
    runtimeRoot?: string;
};
export function readPrivateJson<T>(path: string): T {
    const st = lstatSync(path);
    demand(st.isFile() && !st.isSymbolicLink() && st.nlink === 1 && (st.mode & 0o077) === 0 && (!process.getuid || st.uid === process.getuid()), "UNSAFE_CONTEXT", "Context must be an owner-only regular file");
    return readJson<T>(path);
}
export function managedContext(): boolean {
    return Boolean(process.env.WR_NEXT_CONTEXT || process.env.WR_NEXT_BINDING_REQUIRED || process.env.WR_NEXT_COORDINATOR || process.env.WR_NEXT_COORDINATOR_TOOL);
}
export function coordinatorTool(): import("../runtime/coordinator.js").ToolContext | null {
    const file = process.env.WR_NEXT_COORDINATOR_TOOL;
    if (!file) {
        demand(!process.env.WR_NEXT_COORDINATOR, "UNBOUND_COORDINATOR", "Coordinator operations require a per-tool binding", 403);
        return null;
    }
    demand(process.env.WR_NEXT_COORDINATOR && !process.env.WR_NEXT_CONTEXT && !process.env.WR_NEXT_BINDING_REQUIRED, "AMBIGUOUS_CONTEXT", "Conflicting or missing coordinator context", 403);
    const root = readPrivateJson<import("../runtime/coordinator.js").CoordinatorContext>(process.env.WR_NEXT_COORDINATOR!);
    const tool = readPrivateJson<import("../runtime/coordinator.js").ToolContext>(file);
    demand(tool.version === 1 && typeof tool.dispatch === "string" && root.coordinator === tool.coordinator.coordinator && root.runtimeAgent === tool.coordinator.runtimeAgent && root.server === tool.coordinator.server && root.workspace === tool.coordinator.workspace && root.device === tool.coordinator.device, "UNBOUND_COORDINATOR", "Tool does not belong to this runtime context", 403);
    demand(!tool.worker || tool.worker.runtimeAgent === root.runtimeAgent && tool.worker.run === root.run && tool.worker.server === root.server && tool.worker.workspace === root.workspace && tool.worker.device === root.device, "UNBOUND_COORDINATOR", "Execution belongs to another runtime", 403);
    return tool;
}
export function coordinatorConnection(): Connection | null { return coordinatorTool()?.coordinator ?? null; }
export function context(): ContextFile | null {
    if (process.env.WR_NEXT_COORDINATOR || process.env.WR_NEXT_COORDINATOR_TOOL)
        return coordinatorTool()?.worker ?? null;
    const path = process.env.WR_NEXT_CONTEXT;
    if (!path) {
        demand(!process.env.WR_NEXT_BINDING_REQUIRED, "UNBOUND_RUNTIME_ACTOR", "Managed runtime tools require an explicitly bound actor context", 403);
        return null;
    }
    const st = lstatSync(path);
    demand(st.isFile() && !st.isSymbolicLink() && (st.mode & 0o077) === 0 && (!process.getuid || st.uid === process.getuid()), "UNSAFE_CONTEXT", "Context must be an owner-only regular file");
    const value = readJson<ContextFile>(path);
    if (process.env.WR_NEXT_BINDING_REQUIRED || value.runtimeAgent)
        demand(value.runtimeAgent && process.env.WR_NEXT_RUNTIME_AGENT === value.runtimeAgent, "UNBOUND_RUNTIME_ACTOR", "An inherited context is not a runtime actor binding", 403);
    return value;
}
export function connection(): Connection {
    const ctx = context();
    if (ctx)
        return ctx;
    const co = coordinatorConnection();
    if (co)
        return co;
    const cfg = readJson<Connection>(join(stateHome(), "connection.json"));
    return { ...cfg, ...(process.env.WR_NEXT_SERVER ? { server: process.env.WR_NEXT_SERVER } : {}), ...(process.env.WR_NEXT_TOKEN ? { token: process.env.WR_NEXT_TOKEN } : {}) };
}
