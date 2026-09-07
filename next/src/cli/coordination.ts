import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { join, basename } from "node:path";
import { Client } from "./client.js";
import { atomic, readPrivateJson, stateHome, type Connection } from "./files.js";
import { capabilityConnection } from "../runtime/binding.js";
import { projectRoot, readProjectConfig } from "../integrations/runtime-config/project.js";
import { git, repository as repositoryIdentity } from "../git/repository.js";
import { demand, digest, uid } from "../domain/util.js";
import { CoordinatorBridge } from "../runtime/coordinator.js";
import { processIdentity } from "../runtime/process.js";
export type AgentRegistration = {
    version: 1;
    root: string;
    repository: string;
    environment: string;
    work: string;
    grant: string;
    bootstrap: Connection;
    localAuthority?: {
        database: string;
        fingerprint: string;
    };
};
export const registrationPath = (root: string) => join(stateHome(), "agent-repositories", `${digest({ root: realpathSync(root) })}.json`);
export function readRegistration(cwd: string): AgentRegistration | null {
    const root = projectRoot(cwd), path = registrationPath(root);
    if (!existsSync(path))
        return null;
    const st = lstatSync(path);
    demand(st.isFile() && !st.isSymbolicLink() && (st.mode & 0o077) === 0 && (!process.getuid || st.uid === process.getuid()), "UNSAFE_CONTEXT", "Repository grant must be owner-private");
    const registration = readPrivateJson<AgentRegistration>(path);
    demand(registration.version === 1 && registration.root === root && registration.repository === repositoryIdentity(root), "REPOSITORY_BINDING_CONFLICT", "Repository grant does not match this checkout/origin. Re-enroll explicitly");
    return registration;
}
export async function enableAgentManagement(cwd: string, cfg: Connection, options: {
    work?: string;
    checks?: string[];
} = {}): Promise<unknown> {
    const root = projectRoot(cwd), config = readProjectConfig(root);
    demand(config, "INTEGRATION_NOT_READY", "Initialize static integrations before enabling agent management");
    let repository: string;
    try {
        repository = repositoryIdentity(root);
    }
    catch (error) {
        if ((error as {
            code?: string;
        }).code !== "REPOSITORY_UNKNOWN")
            throw error;
        // Explicit enrollment may assign a local identity; ordinary hooks never do.
        git(root, ["config", "wr-next.repositoryId", `local:${uid("repository")}`]);
        repository = repositoryIdentity(root);
    }
    const environment = git(root, ["rev-parse", "--path-format=absolute", "--git-dir"]);
    const runtimes = ["generic", ...Object.entries(config.integrations).filter(([, enabled]) => enabled).map(([name]) => name)];
    const output = await new Client(cfg).command<any>({ type: "coordination.enable", repository, environment, title: basename(root), runtimes, work: options.work, checks: options.checks });
    atomic(registrationPath(root), { version: 1, root, repository, environment, work: output.result.work, grant: output.result.grant, bootstrap: capabilityConnection(cfg, output.bootstrap), ...(cfg.localAuthority ? { localAuthority: { database: cfg.localAuthority.database, fingerprint: digest({ token: cfg.token, workspace: cfg.workspace, device: cfg.device }) } } : {}) } satisfies AgentRegistration);
    return { enabled: true, scope: output.result.work, nativeBootstrap: runtimes.filter(runtime => ["claude", "codex", "omp"].includes(runtime)), note: "Configured root profiles; actual hook loading and child binding have separate acceptance boundaries." };
}
export async function disableAgentManagement(cwd: string, cfg: Connection, reason: string): Promise<unknown> {
    const reg = readRegistration(cwd);
    demand(reg, "NOT_CONFIGURED", "Repository agent management is not enabled");
    return new Client(cfg).command({ type: "coordination.revoke", grant: reg.grant, reason });
}
/** Local startup may be automated only for this saved, explicitly approved authority identity. */
export async function refreshAgentAuthority(reg: AgentRegistration): Promise<AgentRegistration> {
    if (!reg.localAuthority)
        return reg;
    const path = join(stateHome(), "connection.json"), saved = readPrivateJson<Connection>(path);
    const matches = (cfg: Connection) => cfg.localAuthority?.database === reg.localAuthority!.database && digest({ token: cfg.token, workspace: cfg.workspace, device: cfg.device }) === reg.localAuthority!.fingerprint;
    demand(matches(saved), "AUTHORITY_IDENTITY_CONFLICT", "Re-enroll explicitly after switching the repository authority; no fallback was performed");
    const { ensureConnection } = await import("./authority.js");
    const current = await ensureConnection();
    demand(matches(current), "AUTHORITY_IDENTITY_CONFLICT", "Authority changed during startup");
    if (current.server !== reg.bootstrap.server) {
        reg = { ...reg, bootstrap: { ...reg.bootstrap, server: current.server } };
        atomic(registrationPath(reg.root), reg);
    }
    return reg;
}
/** Change only a verified local transport endpoint, never scope, identity, capability or assignment. */
export function refreshCoordinatorEndpoint(bridge: CoordinatorBridge, registration: AgentRegistration): void {
    if (bridge.context.server === registration.bootstrap.server)
        return;
    demand(registration.localAuthority && bridge.context.work === registration.work && bridge.context.environment === registration.environment && bridge.context.workspace === registration.bootstrap.workspace && bridge.context.device === registration.bootstrap.device, "AUTHORITY_IDENTITY_CONFLICT", "Coordinator and approved authority registration differ");
    const connections = [bridge.context, bridge.observer, bridge.adapter];
    for (const connection of connections) {
        const old = new URL(connection.server), current = new URL(registration.bootstrap.server);
        demand(old.protocol === "http:" && current.protocol === "http:" && old.hostname === "127.0.0.1" && current.hostname === "127.0.0.1" && connection.workspace === registration.bootstrap.workspace && connection.device === registration.bootstrap.device, "AUTHORITY_IDENTITY_CONFLICT", "Only the verified local authority endpoint may change");
    }
    // refreshAgentAuthority must already have authenticated the unchanged database and signing identity.
    for (const connection of connections)
        connection.server = registration.bootstrap.server;
    atomic(bridge.contextFile, bridge.context);
    atomic(join(bridge.contextFile, "..", "controller.json"), { context: bridge.context, observer: bridge.observer, adapter: bridge.adapter });
}
/** Reap only a positively identified, no-longer-live provider process. No TTL-based stealing. */
export async function reapCoordinators(home = stateHome(), registration?: AgentRegistration): Promise<void> {
    const dir = join(home, "coordinator-owners");
    if (!existsSync(dir))
        return;
    for (const name of readdirSync(dir).filter(n => n.endsWith(".json"))) {
        const path = join(dir, name), record = readPrivateJson<{
            controller: string;
            pid: number;
            identity: string;
            ended?: boolean;
        }>(path);
        demand(Number.isSafeInteger(record.pid) && record.pid > 0 && typeof record.identity === "string", "UNSAFE_CONTEXT", "Malformed runtime owner receipt");
        const actual = processIdentity(record.pid);
        if (record.ended || actual === record.identity)
            continue;
        if (!actual) {
            let absent = false;
            try {
                process.kill(record.pid, 0);
            }
            catch (e) {
                absent = (e as NodeJS.ErrnoException).code === "ESRCH";
            }
            if (!absent)
                continue; // unreadable/permission denied is not termination.
        }
        // A changed PID identity proves only this registered process ended, never all descendants.
        try {
            const bridge = CoordinatorBridge.restore(record.controller);
            if (registration?.localAuthority && (record as {
                root?: string;
            }).root === registration.root && bridge.observer.workspace === registration.bootstrap.workspace && bridge.observer.device === registration.bootstrap.device && new URL(bridge.observer.server).hostname === "127.0.0.1") {
                // refreshAgentAuthority has already authenticated the identical saved local database/signing identity.
                bridge.observer.server = registration.bootstrap.server;
            }
            await bridge.stop(true);
            atomic(path, { ...record, ended: true });
        }
        catch { /* Keep the receipt. Revocation/auth/network failure is not process reassignment. */ }
    }
}
