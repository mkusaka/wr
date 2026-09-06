import { basename, join } from "node:path";
import { mkdirSync } from "node:fs";
import { atomic, stateHome, type ContextFile } from "../../cli/files.js";
import { demand, uid } from "../../domain/util.js";
import { runtimeNames, adapterVersion, type RuntimeName } from "../runtime-config/catalog.js";
import { projectRoot, requireInstalled, staticHookDocument } from "../runtime-config/project.js";
export type LaunchProfile = {
    runtime: string;
    argv: string[];
    integration?: ContextFile["integration"];
};
/** Integration policy, not process management. Standard launches never rewrite argv/config. */
export function prepareLaunchProfile(cwd: string, argv: string[], requested?: string, isolated = false): LaunchProfile {
    demand(argv.length > 0, "INVALID_COMMAND", "Provide command after --");
    const executable = basename(argv[0]!);
    const runtime = requested ?? (runtimeNames.includes(executable as RuntimeName) ? executable : "generic");
    demand(["generic", ...runtimeNames].includes(runtime), "UNSUPPORTED_RUNTIME", "Unknown runtime adapter");
    demand(!isolated || runtime === "claude", "UNSUPPORTED_ISOLATION", "Temporary settings are supported only by the explicit Claude isolated profile");
    const profile: LaunchProfile = { runtime, argv: [...argv] };
    if (runtime === "generic" || runtime === "devin")
        return profile;
    if (!isolated) {
        requireInstalled(cwd, runtime as "claude" | "codex" | "omp");
        profile.integration = { runtime, mode: "project", adapterVersion, root: projectRoot(cwd) };
        return profile;
    }
    // Backward-compatible testing escape hatch. No settings generation in runtime/launcher.
    const directory = join(stateHome(), "isolated-integrations", uid("profile"));
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, "claude-settings.json");
    atomic(path, JSON.parse(JSON.stringify(staticHookDocument("claude")).replaceAll("--installation project", "--installation isolated")));
    profile.argv = [argv[0]!, "--settings", path, ...argv.slice(1)];
    profile.integration = { runtime, mode: "isolated", adapterVersion, root: cwd };
    return profile;
}
/** Provider identity inherited from an ancestor is not this invocation's identity. */
export function withoutAncestorProviderSession(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const env = { ...base };
    for (const key of ["CODEX_THREAD_ID", "CLAUDE_CODE_SESSION_ID", "DEVIN_SESSION_ID", "PI_SESSION_ID"])
        delete env[key];
    return env;
}
