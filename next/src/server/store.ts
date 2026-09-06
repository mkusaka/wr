import { emptyState, tables, type State } from "../domain/model.js";
export interface SqlPort {
    all<T extends Record<string, unknown>>(query: string, ...bindings: (string | number | null)[]): T[];
    execute(query: string, ...bindings: (string | number | null)[]): void;
    transaction<T>(fn: () => T): T;
}
/** Identical SQL and transaction boundary on local SQLite and SQLite-backed DO. */
export class Store {
    constructor(readonly sql: SqlPort) {
        sql.transaction(() => {
            sql.execute("CREATE TABLE IF NOT EXISTS schema_versions (version INTEGER PRIMARY KEY)");
            const version = sql.all<{
                version: number;
            }>("SELECT version FROM schema_versions ORDER BY version DESC LIMIT 1")[0]?.version ?? 0;
            if (version > 1)
                throw new Error("Database is newer than this binary");
            if (!version) {
                for (const table of tables)
                    sql.execute(`CREATE TABLE ${table} (id TEXT PRIMARY KEY, body TEXT NOT NULL CHECK(json_valid(body)))`);
                sql.execute("CREATE TABLE metadata (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL)");
                sql.execute("INSERT INTO metadata VALUES(1, ?)", JSON.stringify(emptyState().meta));
                sql.execute("CREATE TABLE operations (principal TEXT NOT NULL, id TEXT NOT NULL, request_hash TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(principal,id))");
                sql.execute("CREATE UNIQUE INDEX work_key ON work(json_extract(body,'$.key'))");
                sql.execute("CREATE INDEX execution_work ON executions(json_extract(body,'$.work'),json_extract(body,'$.state'))");
                sql.execute("CREATE INDEX event_seq ON events(json_extract(body,'$.seq'))");
                sql.execute("INSERT INTO schema_versions VALUES(1)");
            }
        });
    }
    load(): State {
        const state = emptyState();
        for (const table of tables)
            for (const row of this.sql.all<{
                id: string;
                body: string;
            }>(`SELECT id,body FROM ${table} ORDER BY rowid`))
                (state[table] as Record<string, unknown>)[row.id] = JSON.parse(row.body);
        state.meta = JSON.parse(this.sql.all<{
            body: string;
        }>("SELECT body FROM metadata WHERE id=1")[0]!.body);
        return state;
    }
    save(before: State, after: State): void {
        for (const table of tables) {
            for (const [id, row] of Object.entries(after[table])) {
                const body = JSON.stringify(row);
                if (body !== JSON.stringify((before[table] as Record<string, unknown>)[id]))
                    this.sql.execute(`INSERT INTO ${table}(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body`, id, body);
            }
            for (const id of Object.keys(before[table]))
                if (!(id in after[table]))
                    this.sql.execute(`DELETE FROM ${table} WHERE id=?`, id);
        }
        this.sql.execute("UPDATE metadata SET body=? WHERE id=1", JSON.stringify(after.meta));
    }
    snapshot(): State { return this.sql.transaction(() => this.load()); }
}
