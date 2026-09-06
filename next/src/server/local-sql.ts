import { chmodSync, existsSync, lstatSync, openSync, closeSync } from "node:fs";
import { demand } from "../domain/util.js";
import { Database } from "bun:sqlite";
import type { SqlPort } from "./store.js";
export class LocalSql implements SqlPort {
    readonly db: Database;
    constructor(path: string) {
        if (path !== ":memory:") {
            demand(!existsSync(path) || !lstatSync(path).isSymbolicLink(), "UNSAFE_DATABASE", "Database must not be a symlink");
            if (!existsSync(path))
                closeSync(openSync(path, "wx", 0o600));
            chmodSync(path, 0o600);
        }
        this.db = new Database(path, { create: true, strict: true });
        this.db.run("PRAGMA journal_mode=WAL");
        this.db.run("PRAGMA busy_timeout=5000");
        this.db.run("PRAGMA foreign_keys=ON");
    }
    all<T extends Record<string, unknown>>(q: string, ...b: (string | number | null)[]): T[] { return this.db.query(q).all(...b) as T[]; }
    execute(q: string, ...b: (string | number | null)[]): void { this.db.query(q).run(...b); }
    transaction<T>(fn: () => T): T {
        this.db.run("BEGIN IMMEDIATE");
        try {
            const result = fn();
            this.db.run("COMMIT");
            return result;
        }
        catch (error) {
            this.db.run("ROLLBACK");
            throw error;
        }
    }
    close(): void { this.db.close(); }
}
