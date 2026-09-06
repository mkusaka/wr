import type { Principal } from "../domain/model.js";
import { Fault, demand } from "../domain/util.js";
import { envelope, object, text, list } from "../protocol/validate.js";
import { Workspace } from "../domain/service.js";
import { Tokens } from "./auth.js";
import { view, explainCommit, explainPr } from "../projections/views.js";
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
export function application(workspace: Workspace, tokens: Tokens, authenticate: (r: Request) => Principal | Promise<Principal>) {
    return async (request: Request): Promise<Response> => {
        try {
            const url = new URL(request.url), origin = request.headers.get("origin");
            demand(!origin || origin === url.origin, "FORBIDDEN_ORIGIN", "Cross-origin requests are not allowed", 403);
            const p = await authenticate(request);
            if (request.method === "POST") {
                demand((request.headers.get("content-type") ?? "").startsWith("application/json"), "INVALID_INPUT", "JSON required", 415);
                const reader = request.body?.getReader();
                demand(reader, "INVALID_INPUT", "JSON body required", 400);
                let size = 0;
                const chunks: Uint8Array[] = [];
                while (true) {
                    const chunk = await reader.read();
                    if (chunk.done)
                        break;
                    size += chunk.value.byteLength;
                    if (size >= 1024 * 1024) {
                        await reader.cancel();
                        throw new Fault("PAYLOAD_TOO_LARGE", "Request exceeds 1 MiB", 413);
                    }
                    chunks.push(chunk.value);
                }
                const raw = Buffer.concat(chunks).toString("utf8");
                const parsed: unknown = JSON.parse(raw);
                if (url.pathname === "/v1/capabilities") {
                    demand(p.role === "operator", "FORBIDDEN", "Operator capability required", 403);
                    const x = object(parsed, ["execution", "checks"]), execution = x.execution === undefined ? undefined : text(x.execution, "execution");
                    if (execution)
                        demand(workspace.store.snapshot().executions[execution], "NOT_FOUND", "Execution not found", 404);
                    return json({ token: tokens.mint({ ...p, role: "collector", execution, checks: list(x.checks ?? [], x => text(x, "check")) }) });
                }
                demand(url.pathname === "/v1/commands" || url.pathname === "/v1/observations", "NOT_FOUND", "Route not found", 404);
                const message = envelope(parsed);
                const output = workspace.execute(message, p, url.pathname === "/v1/observations") as {
                    result: Record<string, unknown>;
                };
                if (message.command.type === "execution.start") {
                    const e = output.result.execution as string;
                    const base = { id: p.id, device: p.device, execution: e };
                    return json({ ...output, capabilities: { worker: tokens.mint({ ...base, role: "worker" }), launcher: tokens.mint({ ...base, role: "launcher" }), git: tokens.mint({ ...base, role: "collector", checks: ["git:*"] }), github: tokens.mint({ ...base, role: "collector", checks: ["github:*"] }) } });
                }
                return json(output);
            }
            demand(request.method === "GET", "METHOD_NOT_ALLOWED", "Method not allowed", 405);
            const state = workspace.store.snapshot();
            if (url.pathname === "/v1/status" || url.pathname === "/v1/graph") {
                const since = Number(url.searchParams.get("since") ?? 0), offset = Number(url.searchParams.get("offset") ?? 0), limit = Number(url.searchParams.get("limit") ?? 1000);
                demand(Number.isSafeInteger(since) && since >= 0 && Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(limit) && limit > 0 && limit <= 5000, "INVALID_INPUT", "Invalid pagination", 400);
                return json(view(state, p, url.searchParams.get("work") ?? undefined, since, limit, offset));
            }
            if (url.pathname === "/v1/effect") {
                const effect = state.effects[text(url.searchParams.get("id"), "effectId")];
                demand(effect, "NOT_FOUND", "Effect not found", 404);
                demand(p.role === "operator" || p.execution === effect.execution, "FORBIDDEN", "Effect outside context", 403);
                return json(effect);
            }
            if (url.pathname === "/v1/work") {
                const filtered = view(state, p, url.searchParams.get("work") ?? undefined, 0, 5000);
                const id = filtered.scope;
                demand(id, "AMBIGUOUS_CONTEXT", "Select a work item");
                const w = state.work[id]!;
                return json({ revision: state.meta.revision, work: w, executions: Object.values(state.executions).filter(e => e.work === id), results: Object.values(state.results).filter(r => r.work === id), holds: Object.values(state.holds).filter(h => h.work === id), checks: Object.values(state.checks).filter(c => state.results[c.result]?.work === id) });
            }
            demand(p.role === "operator", "FORBIDDEN", "Operator query required", 403);
            if (url.pathname === "/v1/explain/commit")
                return json(explainCommit(state, text(url.searchParams.get("repo"), "repo"), text(url.searchParams.get("sha"), "sha")));
            if (url.pathname === "/v1/explain/pr")
                return json(explainPr(state, text(url.searchParams.get("repo"), "repo"), Number(url.searchParams.get("number"))));
            if (url.pathname === "/v1/snapshot")
                return json(state);
            throw new Fault("NOT_FOUND", "Route not found", 404);
        }
        catch (error) {
            if (error instanceof Fault)
                return json({ error: { code: error.code, message: error.message, details: error.details } }, error.status);
            if (error instanceof SyntaxError)
                return json({ error: { code: "INVALID_JSON", message: "Invalid JSON" } }, 400);
            // Never echo tokens, SQL statements or raw request data.
            return json({ error: { code: "INTERNAL_ERROR", message: "Operation failed; inspect local diagnostics" } }, 500);
        }
    };
}
