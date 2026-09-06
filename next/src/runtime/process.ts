import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
export function processIdentity(pid: number): string | null {
    try {
        if (process.platform === "linux") {
            const fields = readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /, "").split(" ");
            return fields[0] === "Z" || fields[0] === "X" ? null : fields[19] ?? null;
        }
        const p = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
        return p.status === 0 ? p.stdout.trim() : null;
    }
    catch {
        return null;
    }
}
