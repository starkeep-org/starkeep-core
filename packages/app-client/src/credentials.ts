import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AppCredentials {
  appId: string;
  hmacSecret: string;
  dataServerUrl: string;
}

function dataDir(): string {
  return process.env.STARKEEP_DATA_DIR ?? join(homedir(), ".starkeep");
}

export function appCredentialsPath(appId: string): string {
  return join(dataDir(), "app-creds", `${appId}.json`);
}

const cache = new Map<string, AppCredentials | null>();

// Apps re-call this every request; the underlying file is rotated only on
// install/uninstall, which restarts the app process. Re-reads from disk would
// be wasteful here.
export function loadAppCredentials(appId: string): AppCredentials | null {
  if (cache.has(appId)) return cache.get(appId) ?? null;
  const path = appCredentialsPath(appId);
  if (!existsSync(path)) {
    cache.set(appId, null);
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<AppCredentials>;
    if (!parsed.appId || !parsed.hmacSecret) {
      cache.set(appId, null);
      return null;
    }
    const creds: AppCredentials = {
      appId: parsed.appId,
      hmacSecret: parsed.hmacSecret,
      dataServerUrl: parsed.dataServerUrl ?? "http://127.0.0.1:9820",
    };
    cache.set(appId, creds);
    return creds;
  } catch {
    cache.set(appId, null);
    return null;
  }
}

export function clearAppCredentialsCache(appId?: string): void {
  if (appId) cache.delete(appId);
  else cache.clear();
}
