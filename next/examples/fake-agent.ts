import { spawnSync } from "node:child_process";
const call = (args: string[]) => {
    const p = spawnSync("wr-next", args, { encoding: "utf8" });
    if (p.status !== 0)
        throw new Error(p.stderr);
    return JSON.parse(p.stdout);
};
const status = call(["status", "--format", "json"]);
if (status.items.length !== 1)
    throw new Error("Worker should receive only its assigned work");
call(["report", "--decision", "Use the existing contract", "--reason", "No requirement change is necessary"]);
call(["done", "--summary", "Assigned work submitted by the fake agent"]);
console.log(`fake-agent submitted ${status.items[0].key}; no internal IDs supplied`);
