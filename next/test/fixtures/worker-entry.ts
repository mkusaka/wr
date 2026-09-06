// Local workerd smoke harness only. Production entry remains src/server/cloudflare.ts.
import worker, { type Env } from "../../src/server/cloudflare.js";
export { WorkspaceDO } from "../../src/server/cloudflare.js";
export default {
    fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);
        url.protocol = "https:";
        return worker.fetch(new Request(url, request), env);
    }
};
