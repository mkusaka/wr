import { readdirSync, existsSync, unlinkSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { uid, Fault } from "../domain/util.js";
import { stateHome, atomic, readJson, type Connection } from "./files.js";
export type Queued = {
    id: string;
    connection: Connection;
    path: string;
    body: unknown;
    queuedAt: string;
};
export class Client {
    constructor(readonly cfg: Connection) { }
    async request<T = unknown>(path: string, body?: unknown, token = this.cfg.token): Promise<T> {
        let response: Response;
        try {
            response = await fetch(new URL(path, this.cfg.server), { method: body === undefined ? "GET" : "POST", headers: { "authorization": `Bearer ${this.cfg.accessToken ?? token}`, ...(token.startsWith("wn1.") ? { "x-wr-next-capability": token } : {}), "content-type": "application/json", "x-wr-next-workspace": this.cfg.workspace, "x-wr-next-device": this.cfg.device }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000), redirect: "manual" });
        }
        catch {
            throw new Fault("OFFLINE", "Authority is unreachable; local receipt can be synced later", 503);
        }
        if (response.status >= 300 && response.status < 400)
            throw new Fault("AUTHENTICATION_REQUIRED", "Authority redirected to authentication; reconnect explicitly", 401);
        let parsed: unknown;
        try {
            parsed = await response.json();
        }
        catch {
            throw new Fault("INVALID_RESPONSE", "Authority did not return JSON", 502);
        }
        const result = parsed as {
            error?: {
                code: string;
                message: string;
            };
        };
        if (!response.ok)
            throw new Fault(result.error?.code ?? "HTTP_ERROR", result.error?.message ?? `HTTP ${response.status}`, response.status);
        return result as T;
    }
    command<T = any>(command: unknown, options: {
        id?: string;
        revision?: number;
        observed?: boolean;
        queue?: boolean;
    } = {}): Promise<T> {
        return this.send<T>(options.observed ? "/v1/observations" : "/v1/commands", { schemaVersion: 1, operationId: options.id ?? uid("op"), expectedRevision: options.revision, command }, options.queue ?? false);
    }
    async send<T>(path: string, body: unknown, queue: boolean): Promise<T> {
        try {
            return await this.request<T>(path, body);
        }
        catch (error) {
            if (queue && error instanceof Fault && (error.status >= 500 || error.status === 401)) {
                enqueue(this.cfg, path, body);
                throw new Fault("PENDING_SYNC", "Saved locally; not submitted or complete on the authority", 503);
            }
            throw error;
        }
    }
}
export function enqueue(cfg: Connection, path: string, body: unknown): string {
    const id = uid("pending"), record: Queued = { id, connection: cfg, path, body, queuedAt: new Date().toISOString() };
    atomic(join(stateHome(), "outbox", `${Date.now()}-${process.hrtime.bigint().toString().padStart(24, "0")}-${id}.json`), record);
    return id;
}
export function pendingCount(): number { const dir = join(stateHome(), "outbox"); return existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith(".json")).length : 0; }
export async function syncOutbox(): Promise<{
    synced: number;
    pending: number;
    conflicts: string[];
}> {
    const dir = join(stateHome(), "outbox"), conflicts: string[] = [];
    let synced = 0;
    if (!existsSync(dir))
        return { synced, pending: 0, conflicts };
    for (const f of readdirSync(dir).filter(f => f.endsWith(".json")).sort()) {
        const path = join(dir, f);
        let q: Queued;
        try {
            q = readJson<Queued>(path);
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT")
                continue;
            throw error;
        }
        try {
            await new Client(q.connection).request(q.path, q.body);
            try {
                unlinkSync(path);
            }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                    throw error;
            }
            synced++;
        }
        catch (error) {
            if (error instanceof Fault && [400, 403, 404, 409, 422].includes(error.status)) {
                const dead = join(stateHome(), "conflicts");
                mkdirSync(dead, { recursive: true, mode: 0o700 });
                try {
                    renameSync(path, join(dead, f));
                }
                catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                        throw error;
                }
                conflicts.push(`${f}: ${error.code}`);
                continue;
            }
            break;
        }
    }
    return { synced, pending: pendingCount(), conflicts };
}
