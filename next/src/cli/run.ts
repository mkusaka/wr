import { existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { launch, type LaunchOptions, type LaunchResult } from "../runtime/launcher.js";
import { prepareLaunchProfile, withoutAncestorProviderSession } from "../integrations/runtime/launch-profile.js";
import { git, tryGit } from "../git/repository.js";
import { demand, uid } from "../domain/util.js";
import type { Connection } from "./files.js";
export type RunOptions = Omit<LaunchOptions, "environment" | "integration" | "env"> & {
    worktree?: string;
    isolated?: boolean;
};
/** Compose workspace preparation and instrumentation policy before claiming work. */
export async function runWork(cfg: Connection, options: RunOptions): Promise<LaunchResult> {
    demand(options.argv.length, "INVALID_COMMAND", "Provide command after --");
    let cwd = resolve(options.cwd ?? process.cwd());
    if (options.worktree) {
        const location = resolve(options.worktree);
        demand(!existsSync(location), "WORKTREE_EXISTS", "Automatic worktree creation requires a new path");
        git(cwd, ["worktree", "add", "-b", `wr-next/${uid("launch")}`, location]);
        cwd = location;
    }
    // Validate the actual destination once, not both the old and new checkout.
    // A failed preflight leaves a newly created worktree intact for inspection.
    const profile = prepareLaunchProfile(cwd, options.argv, options.runtime, options.isolated);
    const environment = tryGit(cwd, ["rev-parse", "--path-format=absolute", "--git-dir"]) ?? cwd;
    const result = await launch(cfg, { work: options.work, argv: profile.argv, cwd, environment,
        runtime: profile.runtime, integration: profile.integration, env: withoutAncestorProviderSession(process.env),
        role: options.role, readOnly: options.readOnly, continuedFrom: options.continuedFrom, session: options.session });
    if (profile.integration && !existsSync(join(dirname(result.receipt), "integration-seen.json")))
        console.error(`wr-next: ${profile.runtime} exited without a verified SessionStart handshake; hook loading/trust was not proven. Process tracking only; no native-support claim.`);
    return result;
}
