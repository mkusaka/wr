import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { LocalSql } from "./local-sql.js";
import { Store } from "./store.js";
import { Workspace } from "../domain/service.js";
import { application } from "./app.js";
import { Tokens, secureEqual } from "./auth.js";
import { demand } from "../domain/util.js";
export async function startLocal(options: {
    database: string;
    workspace?: string;
    secret?: string;
    port?: number;
}): Promise<{
    server: Server;
    url: string;
    secret: string;
    workspace: Workspace;
    close: () => Promise<void>;
}> {
    const secret = options.secret ?? randomBytes(32).toString("hex"), workspaceId = options.workspace ?? "local";
    if (options.database !== ":memory:")
        mkdirSync(join(options.database, ".."), { recursive: true, mode: 0o700 });
    const sql = new LocalSql(options.database), workspace = new Workspace(new Store(sql));
    const tokens = new Tokens(secret, workspaceId);
    const app = application(workspace, tokens, req => {
        const url = new URL(req.url);
        demand(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "INVALID_HOST", "Local server refuses non-loopback Host", 403);
        demand(req.headers.get("x-wr-next-workspace") === workspaceId, "FORBIDDEN", "Wrong workspace", 403);
        const token = req.headers.get("x-wr-next-capability") ?? (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
        if (secureEqual(token, secret))
            return { id: "local-owner", device: req.headers.get("x-wr-next-device") ?? "local", role: "operator" };
        return tokens.read(token);
    });
    const server = createServer(async (req, res) => {
        try {
            const chunks: Buffer[] = [];
            let size = 0;
            for await (const chunk of req) {
                size += (chunk as Buffer).length;
                if (size > 1024 * 1024) {
                    res.writeHead(413).end();
                    return;
                }
                chunks.push(Buffer.from(chunk));
            }
            const headers = new Headers();
            for (const [k, v] of Object.entries(req.headers))
                if (v !== undefined)
                    headers.set(k, Array.isArray(v) ? v.join(",") : v);
            const request = new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers, ...(req.method !== "GET" && req.method !== "HEAD" ? { body: Buffer.concat(chunks) } : {}) });
            const response = await app(request);
            res.writeHead(response.status, Object.fromEntries(response.headers));
            res.end(Buffer.from(await response.arrayBuffer()));
        }
        catch {
            res.writeHead(500, { "content-type": "application/json" });
            res.end('{"error":{"code":"INTERNAL_ERROR","message":"Request failed"}}');
        }
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.port ?? 0, "127.0.0.1", resolve); });
    const address = server.address() as {
        port: number;
    };
    return { server, url: `http://127.0.0.1:${address.port}`, secret, workspace, close: () => new Promise((resolve, reject) => { server.close(error => { sql.close(); error ? reject(error) : resolve(); }); server.closeAllConnections(); }) };
}
