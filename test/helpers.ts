import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { resolveCurrentContext } from "../src/context.ts";

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

export function testDb() {
  return openDb(join(tempDir("wr-test"), "wr.db"));
}

export function testContext(db: ReturnType<typeof testDb>, threadId: string = crypto.randomUUID()) {
  return resolveCurrentContext(db, process.cwd(), undefined, {
    CODEX_THREAD_ID: threadId,
    TERM_SESSION_ID: `term-${threadId}`,
  });
}
