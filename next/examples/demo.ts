import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startLocal } from "../src/server/local.js";
import { Client } from "../src/cli/client.js";
import { runWork as launch } from "../src/cli/run.js";
import { workpad, mermaid, type View } from "../src/projections/views.js";
const directory = mkdtempSync(join(tmpdir(), "wr-next-demo-"));
const previous = process.env.WR_NEXT_HOME;
process.env.WR_NEXT_HOME = join(directory, "state");
const server = await startLocal({ database: join(directory, "demo.sqlite") });
try {
    const cfg = { server: server.url, workspace: "local", device: "demo-device", token: server.secret }, client = new Client(cfg);
    const parent = await client.command({ type: "work.create", title: "Demo improvement" });
    const first = await client.command({ type: "work.create", title: "Implement change", parent: parent.result.id });
    const second = await client.command({ type: "work.create", title: "Independent review", parent: parent.result.id, needs: [first.result.id] });
    const cwd = join(directory, "checkout");
    mkdirSync(cwd);
    const outcome = await launch(cfg, { work: first.result.id, cwd, argv: [process.execPath, fileURLToPath(new URL("./fake-agent.js", import.meta.url))] });
    if (outcome.exitCode !== 0)
        throw new Error("Fake agent failed");
    const status = await client.request<View>(`/v1/status?work=${parent.result.id}`);
    if (!status.ready.includes(second.result.key))
        throw new Error("Dependent did not become ready");
    console.log(workpad(status));
    console.log(mermaid(status));
    console.log("DEMO PASS: work -> runtime -> result -> acceptance -> frontier");
}
finally {
    await server.close();
    if (previous === undefined)
        delete process.env.WR_NEXT_HOME;
    else
        process.env.WR_NEXT_HOME = previous;
    rmSync(directory, { recursive: true, force: true });
}
