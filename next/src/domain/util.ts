import { createHash, randomUUID } from "node:crypto";
export class Fault extends Error {
    constructor(public code: string, message: string, public status = 409, public details: unknown = null) { super(message); }
}
export function demand(condition: unknown, code: string, message: string, status = 409): asserts condition {
    if (!condition)
        throw new Fault(code, message, status);
}
export function canonical(value: unknown): string {
    if (value === null || typeof value !== "object")
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map(canonical).join(",")}]`;
    return `{${Object.keys(value).sort().filter(k => (value as Record<string, unknown>)[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
}
export const digest = (value: unknown): string => `sha256:${createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex")}`;
export const uid = (prefix: string): string => `${prefix}_${randomUUID()}`;
export const now = (): string => new Date().toISOString();
export const values = <T>(map: Record<string, T>): T[] => Object.values(map);
export const equal = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);
export function manifest(refs: {
    repo: string;
    sha: string;
}[]): {
    repo: string;
    sha: string;
}[] {
    return [...new Map(refs.map(r => [`${r.repo}@${r.sha}`, r])).values()].sort((a, b) => `${a.repo}@${a.sha}`.localeCompare(`${b.repo}@${b.sha}`));
}
