import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, closeSync, rmSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { managedContext, connection, stateHome, readJson, atomic, type Connection } from "./files.js";
import { cliPath } from "./entrypoint.js";
import { processIdentity } from "../runtime/process.js";
import { demand, Fault } from "../domain/util.js";
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function local(cfg: Connection): boolean {
    const u = new URL(cfg.server);
    return u.protocol === "http:" && u.hostname === "127.0.0.1";
}
async function responding(cfg: Connection): Promise<boolean> {
    try {
        const r = await fetch(new URL("/v1/status", cfg.server), { headers: { authorization: `Bearer ${cfg.token}`, "x-wr-next-workspace": cfg.workspace, "x-wr-next-device": cfg.device }, signal: AbortSignal.timeout(500), redirect: "manual" });
        demand(r.ok, "AUTHORITY_IDENTITY_CONFLICT", "A local service responded but rejected the saved authority identity. Do not replace it automatically");
        const body = await r.json().catch(() => { throw new Fault("AUTHORITY_IDENTITY_CONFLICT", "Local authority returned non-JSON content"); }) as {
            snapshot?: unknown;
        };
        demand(typeof body.snapshot === "string", "AUTHORITY_IDENTITY_CONFLICT", "Unexpected local authority response");
        return true;
    }
    catch (error) {
        if (error instanceof Fault)
            throw error;
        return false;
    }
}
function processLive(cfg: Connection): boolean {
    const p = cfg.localAuthority;
    return !!p?.processIdentity && processIdentity(p.pid) === p.processIdentity;
}
/** No remote fallback, SQLite direct access, PID-only lock stealing, or hook autostart. */
export async function ensureConnection(): Promise<Connection> {
    if (managedContext())
        return connection();
    const home = stateHome(), path = join(home, "connection.json"), lock = join(home, ".authority-start.lock");
    let cfg = existsSync(path) ? connection() : null;
    if (process.env.WR_NEXT_SERVER || process.env.WR_NEXT_TOKEN) {
        demand(cfg, "AUTHORITY_NOT_CONFIGURED", "Explicit connection overrides require a saved connection; run connect");
        return cfg;
    }
    if (cfg && (!local(cfg) || !cfg.localAuthority))
        return cfg; // Remote and legacy/manual profiles keep their explicit configuration.
    if (cfg && await responding(cfg))
        return cfg;
    if (cfg)
        demand(cfg.localAuthority?.processIdentity && !processLive(cfg), "AUTHORITY_START_UNKNOWN", "Recorded local authority is still alive but not responding; do not start a second authority");
    const database = cfg?.localAuthority?.database ?? join(home, "workspace.sqlite");
    demand(isAbsolute(database), "AUTHORITY_NOT_CONFIGURED", "Local database path must be absolute");
    demand(cfg || !existsSync(database) || existsSync(lock), "AUTHORITY_START_UNKNOWN", "Unidentified existing database requires explicit serve; refusing to create another authority");
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const deadline = Date.now() + 10000;
    while (true) {
        try {
            mkdirSync(lock, { mode: 0o700 });
            break;
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST")
                throw error;
            if (existsSync(path)) {
                const ready = readJson<Connection>(path);
                if (local(ready) && await responding(ready))
                    return ready;
            }
            demand(Date.now() < deadline, "AUTHORITY_START_UNKNOWN", "Startup lock is held or unresolved; inspect the owner receipt rather than launching twice");
            await sleep(50);
        }
    }
    let releaseLock = true;
    let launched: ReturnType<typeof spawn> | undefined;
    try {
        atomic(join(lock, "owner.json"), { pid: process.pid, processIdentity: processIdentity(process.pid) });
        // Another starter may have finished between our initial probe and lock acquisition.
        cfg = existsSync(path) ? readJson<Connection>(path) : null;
        demand(!cfg || local(cfg) && cfg.localAuthority, "AUTHORITY_CONFIGURATION_CHANGED", "Connection changed while starting a local authority");
        if (cfg && await responding(cfg))
            return cfg;
        demand(cfg || !existsSync(database), "AUTHORITY_START_UNKNOWN", "Unidentified database appeared during startup; inspect rather than opening it automatically");
        if (cfg)
            demand(cfg.localAuthority && local(cfg) && !processLive(cfg), "AUTHORITY_START_UNKNOWN", "Authority configuration changed while starting");
        const fd = openSync(join(home, "authority.log"), "a", 0o600);
        let child: ReturnType<typeof spawn>;
        try {
            child = spawn(process.execPath, [cliPath(), "serve", "--port", "0", "--database", cfg?.localAuthority?.database ?? database, "--workspace", cfg?.workspace ?? "local"], {
                detached: true,
                env: { PATH: process.env.PATH, HOME: process.env.HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME, WR_NEXT_HOME: home },
                stdio: ["ignore", fd, fd],
            });
        }
        finally {
            closeSync(fd);
        }
        launched = child;
        let spawnError: Error | undefined;
        child.once("error", error => { spawnError = error; });
        child.unref();
        while (Date.now() < deadline) {
            if (spawnError)
                throw spawnError;
            if (existsSync(path)) {
                const ready = readJson<Connection>(path);
                if (ready.localAuthority?.pid === child.pid && await responding(ready))
                    return ready;
            }
            if (child.exitCode !== null)
                throw new Fault("AUTHORITY_START_FAILED", "Authority exited during startup; inspect the private authority.log");
            await sleep(50);
        }
        // An ambiguous spawn must not be retried automatically by another CLI.
        releaseLock = false;
        atomic(join(lock, "child.json"), { pid: child.pid, processIdentity: child.pid ? processIdentity(child.pid) : null });
        throw new Fault("AUTHORITY_START_UNKNOWN", "Authority launch has not been confirmed; startup lock and receipt retained");
    }
    finally {
        if (launched?.pid && launched.exitCode === null && processIdentity(launched.pid)) {
            // Remove our lock only if this exact child published an authenticated config.
            try {
                const ready = readJson<Connection>(path);
                if (ready.localAuthority?.pid !== launched.pid || !await responding(ready))
                    releaseLock = false;
            }
            catch {
                releaseLock = false;
            }
            if (!releaseLock)
                atomic(join(lock, "child.json"), { pid: launched.pid, processIdentity: processIdentity(launched.pid) });
        }
        if (releaseLock)
            rmSync(lock, { recursive: true, force: true });
    }
}
/** Stop only our authenticated local profile with a matching OS process fingerprint. */
export async function stopLocalAuthority(): Promise<void> {
    demand(!managedContext(), "FORBIDDEN", "Managed worker cannot stop its authority", 403);
    const cfg = connection();
    demand(local(cfg) && cfg.localAuthority, "AUTHORITY_NOT_CONFIGURED", "No managed local authority");
    demand(await responding(cfg) && processLive(cfg), "AUTHORITY_IDENTITY_CONFLICT", "Cannot establish the original authority process identity");
    process.kill(cfg.localAuthority.pid, "SIGTERM");
    for (let i = 0; i < 100; i++) {
        if (!processLive(cfg))
            return;
        await sleep(25);
    }
    throw new Fault("AUTHORITY_START_UNKNOWN", "Stop not confirmed; do not restart automatically");
}
