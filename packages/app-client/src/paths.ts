import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The one true root for all local Starkeep on-disk state: `data.db`,
 * `config.json`, `app-creds/`, `objects/`, `watches.json`, auth/cloud creds.
 *
 * `STARKEEP_DIR` is the single knob — what the local-data-server (the process
 * that owns and writes this directory) has always used. Every other component
 * (CLIs, admin-web, Drive) resolves the same root through here, so config.json
 * and data.db can never drift apart.
 */
export function starkeepDir(): string {
  return process.env.STARKEEP_DIR ?? join(homedir(), ".starkeep");
}

export const configPath = (): string => join(starkeepDir(), "config.json");
export const dataDbPath = (): string => join(starkeepDir(), "data.db");
export const appCredsPath = (appId: string): string =>
  join(starkeepDir(), "app-creds", `${appId}.json`);
