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
    server: string;
    workspace: string;
    device: string;
    token: string;
    accessToken?: string;
};
export type ContextFile = Connection & {
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
    githubToken?: string;
};
export function context(): ContextFile | null {
    const path = process.env.WR_NEXT_CONTEXT;
    if (!path)
        return null;
    const st = lstatSync(path);
    demand(st.isFile() && !st.isSymbolicLink() && (st.mode & 0o077) === 0 && (!process.getuid || st.uid === process.getuid()), "UNSAFE_CONTEXT", "Context must be an owner-only regular file");
    return readJson<ContextFile>(path);
}
export function connection(): Connection {
    const ctx = context();
    if (ctx)
        return ctx;
    const cfg = readJson<Connection>(join(stateHome(), "connection.json"));
    return { ...cfg, ...(process.env.WR_NEXT_SERVER ? { server: process.env.WR_NEXT_SERVER } : {}), ...(process.env.WR_NEXT_TOKEN ? { token: process.env.WR_NEXT_TOKEN } : {}) };
}
