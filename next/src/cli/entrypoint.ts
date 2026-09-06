import { fileURLToPath } from "node:url";
/** Shared by the launcher, authority and Git installer. No integration side effects. */
export const cliPath = (): string => fileURLToPath(new URL("./main.js", import.meta.url));
export const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;
