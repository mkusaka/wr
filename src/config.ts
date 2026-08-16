import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as v from "valibot";
import { discoverCheckout } from "./git.ts";
import { ConfigSchema, ServerUrlSchema, type Config } from "./validation.ts";

function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const configHome = env.XDG_CONFIG_HOME || (env.HOME ? join(env.HOME, ".config") : undefined);
  if (!configHome) throw new Error("HOME or XDG_CONFIG_HOME is required");
  return join(configHome, "wr", "config.json");
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const path = defaultConfigPath(env);
  if (!existsSync(path)) {
    const config = { repositories: [], deviceId: crypto.randomUUID() };
    writeConfig(config, env);
    return config;
  }
  try {
    const config = v.parse(ConfigSchema, JSON.parse(readFileSync(path, "utf8")));
    if (config.deviceId) return config;
    const updated = { ...config, deviceId: crypto.randomUUID() };
    writeConfig(updated, env);
    return updated;
  } catch {
    throw new Error(`Invalid config: ${path}`);
  }
}

function writeConfig(config: Config, env: NodeJS.ProcessEnv): void {
  const path = defaultConfigPath(env);
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`);
  renameSync(temporaryPath, path);
}

export function setServerUrl(serverUrl: string, env: NodeJS.ProcessEnv = process.env): void {
  const value = v.parse(ServerUrlSchema, serverUrl);
  writeConfig({ ...readConfig(env), serverUrl: value }, env);
}

export function enableRepository(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): { repoRoot: string; changed: boolean } {
  const repoRoot = discoverCheckout(path, true)!.repoRoot;
  const config = readConfig(env);
  if (config.repositories.includes(repoRoot)) return { repoRoot, changed: false };
  config.repositories.push(repoRoot);
  config.repositories.sort();
  writeConfig(config, env);
  return { repoRoot, changed: true };
}

export function disableRepository(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): { repoRoot: string; changed: boolean } {
  const repoRoot = discoverCheckout(path, true)!.repoRoot;
  const config = readConfig(env);
  const repositories = config.repositories.filter((repository) => repository !== repoRoot);
  if (repositories.length === config.repositories.length) return { repoRoot, changed: false };
  writeConfig({ ...config, repositories }, env);
  return { repoRoot, changed: true };
}

export function isRepositoryEnabled(path: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const checkout = discoverCheckout(path);
  return checkout !== null && readConfig(env).repositories.includes(checkout.repoRoot);
}

export function requireEnabledRepository(path: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!isRepositoryEnabled(path, env)) {
    throw new Error(`Repository is not enabled; run wr config enable ${path}`);
  }
}
