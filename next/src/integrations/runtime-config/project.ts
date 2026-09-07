import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, rmdirSync, openSync, closeSync, fsyncSync, accessSync, constants, realpathSync } from "node:fs";
import { dirname, join, delimiter } from "node:path";
import { randomUUID } from "node:crypto";
import { demand, digest, Fault } from "../../domain/util.js";
import { git, gitPath, tryGit } from "../../git/repository.js";
import { managedContext } from "../../cli/files.js";
import { configPath, configPaths, groups, ompExtension, runtimeNames, commands, adapterVersion, type RuntimeName, type HookGroup } from "./catalog.js";
type JsonObject = Record<string, unknown>;
export type ProjectConfig = {
    schemaVersion: 1;
    gitHooks: boolean;
    integrations: Record<RuntimeName, boolean>;
};
type OwnedFile = {
    runtime: Exclude<RuntimeName, "devin">;
    path: string;
    groups?: Record<string, HookGroup>;
    content?: string;
    created: boolean;
};
type Manifest = {
    version: 1;
    files: OwnedFile[];
};
type Change = {
    path: string;
    before: string | null;
    after: string | null;
    mode: number;
};
type Journal = {
    version: 1;
    root: string;
    changes: Change[];
};
export type IntegrationStatus = {
    runtime: RuntimeName;
    configured: boolean;
    installation: "absent" | "intact" | "drift" | "wrapper-only";
    activation: "not-proven";
    nativeBinding: "project-read-only" | "requires-harness" | "unavailable";
    diagnostics: string[];
};
const disabled = (): Record<RuntimeName, boolean> => ({ claude: false, codex: false, omp: false, devin: false });
const fresh = (): ProjectConfig => ({ schemaVersion: 1, gitHooks: true, integrations: disabled() });
const ownedDir = (root: string) => gitPath(root, "wr-next/integrations");
const pretty = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
const same = (a: unknown, b: unknown) => digest(a) === digest(b);
function object(value: unknown, label: string): JsonObject {
    demand(typeof value === "object" && value !== null && !Array.isArray(value), "INVALID_INTEGRATION_CONFIG", `${label} must be a JSON object`, 400);
    return value as JsonObject;
}
function isRegular(path: string): void {
    if (!existsSync(path)) {
        try {
            lstatSync(path);
            demand(false, "UNSAFE_INTEGRATION_PATH", `Dangling link: ${path}`);
        }
        catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "ENOENT")
                throw e;
        }
        return;
    }
    const stat = lstatSync(path);
    demand(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, "UNSAFE_INTEGRATION_PATH", `Expected an unlinked regular file: ${path}`);
    demand((stat.mode & 0o022) === 0, "UNSAFE_INTEGRATION_PATH", `Refusing group/world-writable configuration: ${path}`);
}
function safePath(root: string, relative: string): string {
    demand(!relative.startsWith("/") && !relative.split(/[\\/]/).includes(".."), "UNSAFE_INTEGRATION_PATH", "Repository-relative path required");
    const path = join(root, relative);
    for (let parent = dirname(path); parent !== root; parent = dirname(parent)) {
        if (existsSync(parent))
            demand(lstatSync(parent).isDirectory() && !lstatSync(parent).isSymbolicLink(), "UNSAFE_INTEGRATION_PATH", `Refusing symlink/non-directory: ${parent}`);
        else {
            try {
                lstatSync(parent);
                demand(false, "UNSAFE_INTEGRATION_PATH", `Dangling directory link: ${parent}`);
            }
            catch (e) {
                if ((e as NodeJS.ErrnoException).code !== "ENOENT")
                    throw e;
            }
        }
    }
    isRegular(path);
    return path;
}
function read(path: string): string | null { isRegular(path); return existsSync(path) ? readFileSync(path, "utf8") : null; }
function parse(body: string | null, label: string): JsonObject {
    try {
        return body === null ? {} : object(JSON.parse(body), label);
    }
    catch (e) {
        if (e instanceof Fault)
            throw e;
        throw new Fault("INVALID_INTEGRATION_CONFIG", `${label}: expected strict JSON; no file was changed`, 400);
    }
}
export function projectRoot(cwd: string): string { return realpathSync(git(cwd, ["rev-parse", "--show-toplevel"])); }
function stateFiles(root: string) {
    const dir = ownedDir(root);
    // Git-private metadata never contains execution credentials or runtime hook payloads.
    const parent = dirname(dir);
    if (existsSync(parent))
        demand(lstatSync(parent).isDirectory() && !lstatSync(parent).isSymbolicLink(), "UNSAFE_INTEGRATION_PATH", "Private integration directory is unsafe");
    if (existsSync(dir))
        demand(lstatSync(dir).isDirectory() && !lstatSync(dir).isSymbolicLink(), "UNSAFE_INTEGRATION_PATH", "Private integration directory is unsafe");
    return { dir, manifest: join(dir, "manifest.json"), journal: join(dir, "journal.json"), lock: join(dir, "lock") };
}
export function readProjectConfig(root: string): ProjectConfig | null {
    const body = read(safePath(root, configPath));
    if (body === null)
        return null;
    const p = parse(body, configPath), flags = object(p.integrations, "integrations");
    demand(p.schemaVersion === 1 && typeof p.gitHooks === "boolean" && Object.keys(p).every(k => ["schemaVersion", "gitHooks", "integrations"].includes(k)), "INVALID_INTEGRATION_CONFIG", "Unsupported .wr/config.json schema", 400);
    demand(Object.keys(flags).every(k => runtimeNames.includes(k as RuntimeName)) && runtimeNames.every(k => typeof flags[k] === "boolean"), "INVALID_INTEGRATION_CONFIG", "Integrations must contain boolean claude/codex/omp/devin entries", 400);
    return p as unknown as ProjectConfig;
}
function readManifest(root: string): Manifest {
    const raw = parse(read(stateFiles(root).manifest), "integration manifest");
    if (!Object.keys(raw).length)
        return { version: 1, files: [] };
    demand(raw.version === 1 && Array.isArray(raw.files), "INTEGRATION_STATE_INVALID", "Unknown installation manifest");
    for (const f of raw.files) {
        const x = object(f, "managed file");
        demand(["claude", "codex", "omp"].includes(String(x.runtime)) && x.path === configPaths[x.runtime as keyof typeof configPaths] && typeof x.created === "boolean", "INTEGRATION_STATE_INVALID", "Invalid owned path");
        if (x.runtime === "omp")
            demand(typeof x.content === "string", "INTEGRATION_STATE_INVALID", "Missing owned extension");
        else {
            const gs = object(x.groups, "owned groups");
            for (const [event, g] of Object.entries(gs))
                demand(event in groups(x.runtime as "claude" | "codex") && same(g, groups(x.runtime as "claude" | "codex")[event]), "INTEGRATION_STATE_INVALID", "Unknown owned hook definition; use the previous adapter to uninstall before upgrading");
        }
    }
    return raw as unknown as Manifest;
}
function hookMap(doc: JsonObject): Record<string, unknown[]> {
    if (doc.hooks === undefined)
        return {};
    const hooks = object(doc.hooks, "hooks");
    for (const [name, entries] of Object.entries(hooks))
        demand(Array.isArray(entries), "INVALID_INTEGRATION_CONFIG", `hooks.${name} must be an array`, 400);
    return hooks as Record<string, unknown[]>;
}
/** Remove only exact owned handlers. Keep user siblings, matchers and unrelated settings. */
function removeGroups(doc: JsonObject, owned: Record<string, HookGroup>, strict: boolean): void {
    const hooks = hookMap(doc);
    for (const [event, expected] of Object.entries(owned)) {
        let matches = 0;
        const next: unknown[] = [];
        for (const entry of hooks[event] ?? []) {
            if (typeof entry !== "object" || !entry || Array.isArray(entry)) {
                next.push(entry);
                continue;
            }
            const group = entry as JsonObject;
            if (!Array.isArray(group.hooks)) {
                next.push(entry);
                continue;
            }
            const has = group.hooks.some(h => same(h, expected.hooks[0]));
            if (has) {
                demand(group.matcher === undefined && Object.keys(group).every(k => k === "hooks"), "INTEGRATION_DRIFT", `Managed ${event} matcher/group changed; reconcile manually`);
                const remaining = group.hooks.filter(h => {
                    if (same(h, expected.hooks[0])) {
                        matches++;
                        return false;
                    }
                    return true;
                });
                if (remaining.length)
                    next.push({ ...group, hooks: remaining });
            }
            else
                next.push(entry);
        }
        demand(matches <= 1 && (!strict || matches === 1), "INTEGRATION_DRIFT", `Missing, changed or duplicate managed ${event} handler; no changes applied`);
        if (next.length)
            hooks[event] = next;
        else
            delete hooks[event];
    }
    if (Object.keys(hooks).length)
        doc.hooks = hooks;
    else
        delete doc.hooks;
}
function hasOurCommand(doc: JsonObject): boolean { return /wr-next[^"\n]*(?:runtime-event|integration-event)/.test(JSON.stringify(doc)); }
function renderFile(root: string, runtime: Exclude<RuntimeName, "devin">, enable: boolean, old?: OwnedFile): {
    change: Change;
    owned?: OwnedFile;
} {
    const relative = configPaths[runtime], path = safePath(root, relative), before = read(path), mode = existsSync(path) ? lstatSync(path).mode & 0o777 : 0o644;
    if (runtime === "omp") {
        const generated = ompExtension();
        if (old)
            demand(before === old.content, "INTEGRATION_DRIFT", "Managed OMP extension was modified or removed; reconcile manually");
        else
            demand(before === null || before === generated, "INTEGRATION_CONFLICT", "Refusing to replace an existing .omp/extensions/wr-next.ts");
        return { change: { path, before, after: enable ? generated : null, mode }, ...(enable ? { owned: { runtime, path: relative, content: generated, created: old?.created ?? before === null } } : {}) };
    }
    const doc = parse(before, relative), expected = groups(runtime);
    if (old?.groups)
        removeGroups(doc, old.groups, true);
    else
        removeGroups(doc, expected, false); // Adopt an exact shared projection in a fresh clone.
    demand(!hasOurCommand(doc), "INTEGRATION_CONFLICT", `${relative} has another wr-next hook source; remove/reconcile it explicitly`);
    if (enable) {
        if (runtime === "claude")
            demand(doc.disableAllHooks !== true && doc.allowManagedHooksOnly !== true, "INTEGRATION_DISABLED", "Project settings disable non-managed hooks; no permission setting will be changed");
        const hooks = hookMap(doc);
        for (const [event, group] of Object.entries(expected))
            hooks[event] = [...(hooks[event] ?? []), group];
        doc.hooks = hooks;
    }
    const created = old?.created ?? before === null;
    let after = !enable && created && Object.keys(doc).length === 0 ? null : pretty(doc);
    // Preserve exact bytes and mtime on an idempotent init/sync.
    if (before !== null && same(parse(before, relative), doc))
        after = before;
    return { change: { path, before, after, mode }, ...(enable ? { owned: { runtime, path: relative, groups: expected, created } } : {}) };
}
function atomicText(path: string, content: string | null, mode: number): void {
    if (content === null) {
        if (existsSync(path))
            unlinkSync(path);
        return;
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${randomUUID()}.tmp`, fd = openSync(tmp, "wx", mode);
    try {
        writeFileSync(fd, content);
        fsyncSync(fd);
    }
    finally {
        closeSync(fd);
    }
    try {
        renameSync(tmp, path);
    }
    finally {
        if (existsSync(tmp))
            unlinkSync(tmp);
    }
    const parent = openSync(dirname(path), "r");
    try {
        fsyncSync(parent);
    }
    finally {
        closeSync(parent);
    }
}
function locked<T>(root: string, operation: () => T): T {
    demand(!managedContext(), "FORBIDDEN", "Runtime integration settings are operator-owned", 403);
    const s = stateFiles(root);
    mkdirSync(s.dir, { recursive: true, mode: 0o700 });
    try {
        mkdirSync(s.lock, { mode: 0o700 });
    }
    catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST")
            throw new Fault("INTEGRATION_BUSY", "Another installer or an interrupted install owns the lock; verify its process before recovering");
        throw e;
    }
    try {
        writeFileSync(join(s.lock, "owner.json"), pretty({ pid: process.pid, at: new Date().toISOString() }), { mode: 0o600 });
        return operation();
    }
    finally {
        unlinkSync(join(s.lock, "owner.json"));
        rmdirSync(s.lock);
    }
}
function recoverLocked(root: string): void {
    const s = stateFiles(root), body = read(s.journal);
    if (!body)
        return;
    const journal = parse(body, "integration journal") as unknown as Journal;
    demand(journal.version === 1 && journal.root === root && Array.isArray(journal.changes), "INTEGRATION_STATE_INVALID", "Journal belongs to another repository");
    const allowed = new Set([configPath, ...Object.values(configPaths)].map(p => safePath(root, p)).concat(s.manifest));
    for (const c of journal.changes) {
        demand(Number.isInteger(c.mode) && c.mode >= 0 && c.mode <= 0o777 && (c.mode & 0o022) === 0 && allowed.has(c.path) && (c.before === null || typeof c.before === "string") && (c.after === null || typeof c.after === "string"), "INTEGRATION_STATE_INVALID", "Invalid journal entry");
        const current = read(c.path);
        demand(current === c.before || current === c.after, "INTEGRATION_RECOVERY_CONFLICT", "A file changed outside the interrupted install; preserve journal and reconcile manually");
    }
    for (const c of [...journal.changes].reverse())
        if (read(c.path) === c.after)
            atomicText(c.path, c.before, c.mode);
    unlinkSync(s.journal);
}
export function recoverIntegrations(cwd: string): void { const root = projectRoot(cwd); locked(root, () => recoverLocked(root)); }
function commitChanges(root: string, changes: Change[]): void {
    const effective = changes.filter(c => c.before !== c.after), s = stateFiles(root);
    if (!effective.length)
        return;
    for (const c of effective)
        demand(read(c.path) === c.before, "INTEGRATION_CONFLICT", "Configuration changed during planning; retry after review");
    atomicText(s.journal, pretty({ version: 1, root, changes: effective }), 0o600);
    try {
        for (const c of effective) {
            demand(read(c.path) === c.before, "INTEGRATION_CONFLICT", "Configuration changed during installation");
            atomicText(c.path, c.after, c.mode);
        }
        unlinkSync(s.journal);
    }
    catch (e) {
        recoverLocked(root);
        throw e;
    }
}
function executable(name: string): boolean {
    return (process.env.PATH ?? "").split(delimiter).filter(Boolean).some(dir => {
        try {
            accessSync(join(dir, name), constants.X_OK);
            return true;
        }
        catch {
            return false;
        }
    });
}
export function detectedRuntimes(root: string): RuntimeName[] { return runtimeNames.filter(r => existsSync(join(root, r === "claude" ? ".claude" : r === "codex" ? ".codex" : r === "omp" ? ".omp" : ".devin")) || executable(r)); }
function claudeLocalConflict(root: string): void {
    const body = read(safePath(root, ".claude/settings.local.json"));
    if (!body)
        return;
    const local = parse(body, "Claude local settings");
    demand(!hasOurCommand(local), "INTEGRATION_CONFLICT", "Claude local settings contain another wr-next hook source; reconcile it before installing the project source");
    demand(local.disableAllHooks !== true && local.allowManagedHooksOnly !== true, "INTEGRATION_DISABLED", "Claude local settings disable hooks; no user policy was changed");
}
function codexConflict(root: string): void {
    const body = read(safePath(root, ".codex/config.toml"));
    if (!body)
        return;
    // Deliberately refuse complex/inline TOML hooks rather than parse/rewrite a user's TOML.
    demand(!/^\s*\[\[?\s*["']?hooks["']?(?:\s*[.\]]|\s*$)/m.test(body) && !/^\s*hooks\s*=\s*\{/m.test(body), "CODEX_INLINE_HOOKS", "This layer already declares inline hooks; choose one representation manually. config.toml was not changed");
    demand(!/^\s*(?:hooks|codex_hooks)\s*=\s*false/m.test(body) && !/^\s*allow_managed_hooks_only\s*=\s*true/m.test(body), "INTEGRATION_DISABLED", "Codex hooks are disabled/managed-only in this layer; no trust or policy setting was changed");
}
export type InstallOptions = {
    runtimes?: RuntimeName[];
    disable?: RuntimeName[];
    gitHooks?: boolean;
    dryRun?: boolean;
};
export function syncIntegrations(cwd: string, options: InstallOptions = {}): {
    root: string;
    config: ProjectConfig;
    changed: string[];
    statuses: IntegrationStatus[];
    dryRun: boolean;
} {
    const root = projectRoot(cwd);
    const operation = () => {
        const s = stateFiles(root);
        demand(!existsSync(s.journal), "INTEGRATION_RECOVERY_REQUIRED", "Interrupted installation; run integrations recover first");
        const config = readProjectConfig(root) ?? fresh(), manifest = readManifest(root);
        for (const name of options.runtimes ?? [])
            config.integrations[name] = true;
        for (const name of options.disable ?? [])
            config.integrations[name] = false;
        if (options.gitHooks !== undefined)
            config.gitHooks = options.gitHooks;
        if (config.integrations.codex)
            codexConflict(root);
        if (config.integrations.claude)
            claudeLocalConflict(root);
        const files: OwnedFile[] = [], changes: Change[] = [];
        for (const runtime of ["claude", "codex", "omp"] as const) {
            const old = manifest.files.find(f => f.runtime === runtime);
            if (!config.integrations[runtime] && !old && !options.disable?.includes(runtime))
                continue;
            const planned = renderFile(root, runtime, config.integrations[runtime], old);
            changes.push(planned.change);
            if (planned.owned)
                files.push(planned.owned);
        }
        const path = safePath(root, configPath), before = read(path);
        changes.push({ path, before, after: before !== null && same(parse(before, configPath), config) ? before : pretty(config), mode: existsSync(path) ? lstatSync(path).mode & 0o777 : 0o644 });
        changes.push({ path: s.manifest, before: read(s.manifest), after: pretty({ version: 1, files }), mode: 0o600 });
        if (!options.dryRun)
            commitChanges(root, changes);
        return { root, config, changed: changes.filter(c => c.before !== c.after).map(c => c.path), statuses: options.dryRun ? [] : integrationStatus(root), dryRun: options.dryRun ?? false };
    };
    // A dry run does not create state directories/locks or initialize an authority.
    return options.dryRun ? operation() : locked(root, operation);
}
export function integrationStatus(cwd: string): IntegrationStatus[] {
    const root = projectRoot(cwd), config = readProjectConfig(root), manifest = readManifest(root);
    return runtimeNames.map(runtime => {
        const diagnostics: string[] = [];
        const configured = config?.integrations[runtime] ?? false;
        let installation: IntegrationStatus["installation"] = configured ? runtime === "devin" ? "wrapper-only" : "intact" : "absent";
        if (runtime !== "devin" && configured) {
            try {
                const owned = manifest.files.find(f => f.runtime === runtime);
                const body = read(safePath(root, configPaths[runtime]));
                demand(body !== null, "INTEGRATION_DRIFT", "Static runtime configuration is missing in this worktree");
                if (runtime === "omp") {
                    demand(body === (owned?.content ?? ompExtension()), "INTEGRATION_DRIFT", "OMP extension differs from installed projection");
                    demand(tryGit(root, ["check-ignore", configPaths.omp]) === null, "INTEGRATION_IGNORED", "OMP native discovery may ignore this gitignored extension");
                }
                else {
                    const doc = parse(body, configPaths[runtime]);
                    removeGroups(doc, owned?.groups ?? groups(runtime), true);
                    demand(!hasOurCommand(doc), "INTEGRATION_CONFLICT", "Another wr-next hook source exists in this file");
                    if (runtime === "claude") {
                        demand(doc.disableAllHooks !== true && doc.allowManagedHooksOnly !== true, "INTEGRATION_DISABLED", "Claude project disables hooks");
                        claudeLocalConflict(root);
                    }
                    else
                        codexConflict(root);
                }
            }
            catch (e) {
                installation = "drift";
                diagnostics.push(e instanceof Error ? e.message : String(e));
            }
        }
        if (runtime === "codex" && configured)
            diagnostics.push("Review/trust the .codex project and exact hooks in Codex /hooks. Installation is not proof of trust or activation.");
        if (runtime === "omp" && configured)
            diagnostics.push("OMP native extension discovery is cwd-local. Start from this worktree root. OMP 18.1.13 supports explicitly delegated read-only native task children and hub conversation; load wr-next after other input rewriters.");
        if (runtime === "devin")
            diagnostics.push("Wrapper/process and Git/PR capture only; no native lifecycle config is installed.");
        if (runtime === "claude" && configured)
            diagnostics.push("Restart sessions after changing settings. Global/managed hook precedence is not inferred from files here.");
        return { runtime, configured, installation, activation: "not-proven", nativeBinding: runtime === "devin" ? "unavailable" : runtime === "claude" || runtime === "omp" ? "project-read-only" : "requires-harness", diagnostics };
    });
}
export function requireInstalled(cwd: string, runtime: RuntimeName): void {
    if (runtime === "devin")
        return;
    const root = projectRoot(cwd), s = stateFiles(root);
    demand(!existsSync(s.journal) && !existsSync(s.lock), "INTEGRATION_BUSY", "Static configuration is being changed or requires recovery");
    const status = integrationStatus(root).find(s => s.runtime === runtime)!;
    demand(status.installation === "intact", "INTEGRATION_NOT_READY", `${runtime}: run wr-next init --runtime ${runtime}, then review integrations status. ${status.diagnostics.join(" ")}`);
    if (runtime === "omp")
        demand(realpathSync(cwd) === root, "OMP_PROJECT_ROOT_REQUIRED", "OMP project extension discovery is cwd-local: run from the worktree root");
}
export function staticHookDocument(runtime: "claude" | "codex"): unknown { return { hooks: Object.fromEntries(Object.entries(groups(runtime)).map(([e, g]) => [e, [g]])) }; }
export const integrationCommand = commands;
export const integrationAdapterVersion = adapterVersion;
