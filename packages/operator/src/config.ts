/**
 * `~/.starkeep/config.json`: the single record of this machine's Starkeep
 * setup, which admin-web, the CLI and the installer scripts all read.
 *
 * No region is stored. Region is derived from `userPoolId` at the point of
 * use, so the file never holds two answers that can disagree.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { starkeepDir } from "@starkeep/app-client";
import { DEFAULT_APPS_DIR } from "@starkeep/admin-installer/app-discovery";

/** The fields that code outside the wizard reads by name. */
export interface StarkeepConfig {
  stackPrefix?: string;
  accountId?: string;
  managerRoleArn?: string;
  publicBaseUrl?: string;
  apiGatewayUrl?: string;
  userPoolId?: string;
  userPoolClientId?: string;
  identityPoolId?: string;
  deviceUserPoolClientId?: string;
  cognitoDomain?: string;
  cloudUrl?: string;
  appParentDirs?: string[];
}

export function configFile(): string {
  return join(starkeepDir(), "config.json");
}

/** The parsed file, or null when it is missing or unreadable. */
export function readConfig(): Record<string, unknown> | null {
  const path = configFile();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Write the whole file. The write goes through a temporary file and a rename,
 * so admin-web and the CLI never read half a file.
 */
export function writeConfig(config: Record<string, unknown>): void {
  const path = configFile();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2), "utf-8");
  renameSync(tmp, path);
}

/**
 * Seed `appParentDirs` with core's example app the first time the config is
 * read without one. A defined empty array means the person cleared the list on
 * purpose, and stays empty.
 */
export function readConfigSeeded(): Record<string, unknown> {
  const config = readConfig();
  if (config && Array.isArray(config.appParentDirs)) return config;
  const seeded = { ...(config ?? {}), appParentDirs: [DEFAULT_APPS_DIR] };
  writeConfig(seeded);
  return seeded;
}

/**
 * Shallow-merge `patch` into the file, creating it when missing. A null value
 * deletes the field, which is how the wizard invalidates later steps when the
 * person goes back. Returns the merged config.
 */
export function patchConfig(patch: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...(readConfig() ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  // Region is always derived from `userPoolId`, so neither field is ever kept.
  delete merged.region;
  delete merged.s3Region;
  writeConfig(merged);
  return merged;
}

/** The config, for code that cannot go on without it. */
export function readStarkeepConfig(): StarkeepConfig {
  const path = configFile();
  if (!existsSync(path)) {
    throw new Error("~/.starkeep/config.json not found — complete the cloud setup first");
  }
  return JSON.parse(readFileSync(path, "utf-8")) as StarkeepConfig;
}

/** The AWS region a Cognito user pool id names, such as `us-east-2_AbCdEf`. */
export function regionFromUserPoolId(userPoolId: string): string {
  const region = userPoolId.split("_")[0];
  if (!region) throw new Error(`Cannot read a region from user pool id "${userPoolId}"`);
  return region;
}
