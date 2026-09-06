import { Fault } from "../domain/util.js";
export type ObjectValue = Record<string, unknown>;
export const bad = (message: string): never => { throw new Fault("INVALID_INPUT", message, 400); };
export function object(value: unknown, allowed?: string[]): ObjectValue {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return bad("Expected object");
    const x = value as ObjectValue;
    if (Object.keys(x).some(k => ["__proto__", "prototype", "constructor"].includes(k) || (allowed && !allowed.includes(k))))
        return bad("Unknown or reserved field");
    return x;
}
export function text(value: unknown, name: string, max = 16384, allowEmpty = false): string {
    if (typeof value !== "string" || (!allowEmpty && !value.trim()) || value.length > max || value.includes("\u0000"))
        return bad(`Invalid ${name}`);
    if (["__proto__", "constructor", "prototype"].includes(value))
        return bad(`Reserved ${name}`);
    return value;
}
export function integer(value: unknown, name: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
    if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max)
        return bad(`Invalid ${name}`);
    return value as number;
}
export function list<T>(value: unknown, parse: (x: unknown) => T, limit = 1000): T[] {
    if (!Array.isArray(value) || value.length > limit)
        return bad("Invalid array");
    return value.map(parse);
}
export function choice<T extends string>(value: unknown, choices: readonly T[]): T {
    if (typeof value !== "string" || !choices.includes(value as T))
        return bad(`Expected one of ${choices.join(",")}`);
    return value as T;
}
export const optionalText = (x: unknown, name: string): string | undefined => x === undefined ? undefined : text(x, name);
export function flag(x: unknown): boolean {
    if (x === undefined)
        return false;
    if (typeof x !== "boolean")
        return bad("Expected boolean");
    return x;
}
export function refs(x: unknown): {
    repo: string;
    sha: string;
}[] {
    return list(x ?? [], v => {
        const r = object(v, ["repo", "sha"]);
        const sha = text(r.sha, "sha", 64);
        if (!/^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(sha))
            return bad("Expected full SHA");
        return { repo: text(r.repo, "repo", 400), sha };
    });
}
export type Envelope = {
    schemaVersion: 1;
    operationId: string;
    expectedRevision?: number;
    command: ObjectValue & {
        type: string;
    };
};
const fields: Record<string, string[]> = {
    "work.create": ["replan", "title", "description", "parent", "needs", "links", "policy", "priority", "lane", "resources", "alias"],
    "work.plan": ["changes"], "work.update": ["work", "title", "description", "policy", "phase", "priority", "replan", "resources", "lane"],
    "dependency.add": ["prerequisite", "dependent", "predicate"], "dependency.remove": ["prerequisite", "dependent"],
    "work.cancel": ["work", "reason"], "work.reopen": ["work", "reason"],
    "work.report": ["work", "kind", "summary", "reason"], "hold.resolve": ["hold", "reason"],
    "lane.set": ["lane", "capacity"],
    "execution.start": ["work", "launchId", "environment", "runtime", "role", "mode", "session", "continuedFrom", "delegationToken", "metadata", "existingRun"],
    "execution.recover": ["execution", "reason", "stopped"],
    "result.submit": ["work", "summary", "manifest"],
    "delegation.issue": ["work", "objective", "role", "mode", "runtimeChildId"],
    "delegation.revoke": ["delegation", "reason"],
    "runtime.attach": ["work", "runtime", "externalSessionId", "agentId", "invocationId", "environment", "role", "mode", "continuedFrom"],
    "runtime.child": ["parent", "externalSessionId", "agentId", "invocationId", "environment", "delegationToken"],
    "runtime.bind": ["agent", "environment", "delegationToken"],
    "runtime.credentials": ["agent"],
    "runtime.lifecycle": ["agent", "event", "windowId", "exitCode", "reason", "sequence"],
    "effect.prepare": ["effectId", "work", "kind", "payload"], "effect.begin": ["effectId"], "effect.resolve": ["effectId", "state", "result"],
    "import.apply": ["source", "digest", "title", "units", "lanes", "shared"],
    "migration.mode": ["source", "mode", "confirm", "comparison"],
    "runtime.event": ["execution", "event", "externalSessionId", "windowId", "exitCode", "signal", "reason"],
    "check.record": ["result", "name", "subject", "status", "evidence"],
    "git.commit": ["snapshot", "snapshotDigest", "commit"],
    "git.rewrite": ["repo", "pairs", "operation"],
    "github.sync": ["pullRequest", "effectId"],
};
export function command(value: unknown): ObjectValue & {
    type: string;
} {
    const x = object(value);
    const type = text(x.type, "type", 80);
    const known = fields[type];
    if (!known)
        return bad(`Unsupported command ${type}`);
    object(x, ["type", ...known]);
    if (type === "work.plan")
        list(x.changes, y => {
            const parsed = command(y);
            if (!["work.create", "work.update", "dependency.add", "dependency.remove", "work.cancel", "work.reopen", "lane.set"].includes(parsed.type))
                return bad("Not a plan change");
            return parsed;
        }, 200);
    return { ...x, type };
}
export function envelope(value: unknown): Envelope {
    const x = object(value, ["schemaVersion", "operationId", "expectedRevision", "command"]);
    if (x.schemaVersion !== 1)
        return bad("Unsupported schema version");
    return { schemaVersion: 1, operationId: text(x.operationId, "operationId", 128), expectedRevision: x.expectedRevision === undefined ? undefined : integer(x.expectedRevision, "expectedRevision"), command: command(x.command) };
}
