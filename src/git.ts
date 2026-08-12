import { realpathSync } from "node:fs";

export type Checkout = {
  repoRoot: string;
  worktreePath: string;
  branch: string | null;
};

function git(path: string, args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", path, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0)
    throw new Error(result.stderr.toString().trim() || `${path} is not a Git checkout`);
  return result.stdout.toString().trim();
}

export function discoverCheckout(path: string, required = false): Checkout | null {
  try {
    const worktreePath = realpathSync(git(path, ["rev-parse", "--show-toplevel"]));
    git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const porcelain = git(path, ["worktree", "list", "--porcelain"]);
    const mainLine = porcelain.split("\n").find((line) => line.startsWith("worktree "));
    if (!mainLine) throw new Error("Could not determine the main worktree");
    const repoRoot = realpathSync(mainLine.slice("worktree ".length));
    const branch = git(path, ["branch", "--show-current"]) || null;
    return { repoRoot, worktreePath, branch };
  } catch (error) {
    if (required) throw error;
    return null;
  }
}
