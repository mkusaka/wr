import { Store, type SqlPort } from "./store.js";
import { Workspace } from "../domain/service.js";
import { Tokens, accessPrincipal } from "./auth.js";
import { application } from "./app.js";
import { demand, Fault } from "../domain/util.js";
import type { Principal } from "../domain/model.js";
// Minimal structural types keep the domain independent of a Worker SDK version.
interface Storage {
    sql: {
        exec<T extends Record<string, unknown>>(q: string, ...b: (string | number | null)[]): Iterable<T>;
    };
    transactionSync<T>(fn: () => T): T;
}
interface Context {
    storage: Storage;
}
interface Namespace {
    idFromName(name: string): unknown;
    get(id: unknown): {
        fetch(request: Request): Promise<Response>;
    };
}
export interface Env {
    WORKSPACES: Namespace;
    SIGNING_SECRET: string;
    ACCESS_ISSUER: string;
    ACCESS_AUDIENCE: string;
    WORKSPACE_MEMBERS: string;
}
export class WorkspaceDO {
    private workspace: Workspace;
    constructor(ctx: Context, private env: Env) {
        const port: SqlPort = { all: <T extends Record<string, unknown>>(q: string, ...b: (string | number | null)[]) => Array.from(ctx.storage.sql.exec<T>(q, ...b)), execute: (q, ...b) => { Array.from(ctx.storage.sql.exec(q, ...b)); }, transaction: fn => ctx.storage.transactionSync(fn) };
        this.workspace = new Workspace(new Store(port));
    }
    fetch(request: Request): Promise<Response> {
        const workspace = request.headers.get("x-wr-next-workspace") ?? "";
        const tokens = new Tokens(this.env.SIGNING_SECRET, workspace);
        return application(this.workspace, tokens, r => tokens.read((r.headers.get("authorization") ?? "").replace(/^Bearer /, "")))(request);
    }
}
export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        try {
            const url = new URL(request.url);
            demand(url.protocol === "https:", "FORBIDDEN", "HTTPS required", 403);
            const workspace = request.headers.get("x-wr-next-workspace") ?? "";
            demand(/^[a-zA-Z0-9_.-]{1,100}$/.test(workspace), "INVALID_WORKSPACE", "Select workspace", 400);
            const tokens = new Tokens(env.SIGNING_SECRET, workspace), bearer = request.headers.get("x-wr-next-capability") ?? (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
            let p: Principal;
            if (bearer.startsWith("wn1.")) {
                p = tokens.read(bearer);
                const assertion = request.headers.get("cf-access-jwt-assertion");
                if (assertion) {
                    const upstream = await accessPrincipal(assertion, env.ACCESS_ISSUER, env.ACCESS_AUDIENCE, p.device);
                    demand(upstream.id === p.id, "FORBIDDEN", "Access principal and capability disagree", 403);
                }
            }
            else
                p = await accessPrincipal(request.headers.get("cf-access-jwt-assertion") ?? bearer, env.ACCESS_ISSUER, env.ACCESS_AUDIENCE, request.headers.get("x-wr-next-device") ?? "");
            demand(p.device && p.device.length <= 150, "INVALID_DEVICE", "Device identity required", 400);
            const memberships = JSON.parse(env.WORKSPACE_MEMBERS) as Record<string, string[]>;
            demand(Array.isArray(memberships[workspace]) && memberships[workspace]!.includes(p.id), "FORBIDDEN", "Not a workspace member", 403);
            const headers = new Headers(request.headers);
            headers.set("authorization", `Bearer ${tokens.mint(p, 900)}`);
            headers.delete("cf-access-jwt-assertion");
            headers.delete("x-wr-next-capability");
            return env.WORKSPACES.get(env.WORKSPACES.idFromName(workspace)).fetch(new Request(request, { headers }));
        }
        catch (error) {
            return Response.json({ error: { code: error instanceof Fault ? error.code : "AUTHENTICATION_FAILED", message: error instanceof Fault ? error.message : "Authentication failed" } }, { status: error instanceof Fault ? error.status : 401 });
        }
    }
};
