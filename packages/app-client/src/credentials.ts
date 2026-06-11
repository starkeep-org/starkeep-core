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
const cloudCache = new Map<string, Promise<AppCredentials | null>>();

/**
 * Synchronous credential load.
 *
 * Local mode (default): reads `~/.starkeep/app-creds/${appId}.json` written by
 * admin-web at install time.
 *
 * Cloud mode: returns null synchronously — cloud creds live in SSM and must
 * be fetched async. Callers running in cloud Lambdas should use
 * `loadAppCredentialsAsync` instead, or rely on the in-process cache
 * (`primeCloudAppCredentials`) populated at module load.
 */
export function loadAppCredentials(appId: string): AppCredentials | null {
  if (cache.has(appId)) return cache.get(appId) ?? null;
  if (clientMode() === "cloud") {
    // Cloud secret cannot be fetched synchronously. Return null; the async
    // path below is the supported entry point for cloud Lambdas.
    return null;
  }
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

/**
 * Async credential load. In cloud mode, fetches the HMAC secret from SSM via
 * the Lambda's exec role; the data-server URL comes from
 * `STARKEEP_CLOUD_DATA_BASE`. In local mode, delegates to the sync path.
 *
 * Cached per process — the underlying SSM parameter is rotated only on
 * install/uninstall, which redeploys the Lambda.
 */
export async function loadAppCredentialsAsync(
  appId: string,
): Promise<AppCredentials | null> {
  if (cache.has(appId)) return cache.get(appId) ?? null;
  if (clientMode() !== "cloud") return loadAppCredentials(appId);
  const existing = cloudCache.get(appId);
  if (existing) return existing;
  const promise = fetchCloudCredentials(appId).then((creds) => {
    cache.set(appId, creds);
    return creds;
  });
  cloudCache.set(appId, promise);
  return promise;
}

function clientMode(): "local" | "cloud" {
  return process.env.STARKEEP_APP_CLIENT_MODE === "cloud" ? "cloud" : "local";
}

async function fetchCloudCredentials(appId: string): Promise<AppCredentials | null> {
  const base = process.env.STARKEEP_CLOUD_DATA_BASE;
  if (!base) {
    throw new Error(
      "STARKEEP_APP_CLIENT_MODE=cloud but STARKEEP_CLOUD_DATA_BASE is not set",
    );
  }
  const explicitName = process.env.STARKEEP_APP_CREDS_PARAMETER_NAME;
  const stackPrefix = process.env.STACK_PREFIX ?? process.env.STARKEEP_STACK_PREFIX;
  const name = explicitName ?? (stackPrefix ? `/${stackPrefix}/app-creds/${appId}` : null);
  if (!name) {
    throw new Error(
      "Cloud mode needs STARKEEP_APP_CREDS_PARAMETER_NAME or STACK_PREFIX to locate the SSM parameter",
    );
  }
  // Lazy import keeps `@aws-sdk/client-ssm` off the load path in local mode.
  const { SSMClient, GetParameterCommand, ParameterNotFound } = await import(
    "@aws-sdk/client-ssm"
  );
  const ssm = new SSMClient({
    region: process.env.AWS_REGION ?? "us-east-1",
  });
  try {
    const result = await ssm.send(
      new GetParameterCommand({ Name: name, WithDecryption: true }),
    );
    const raw = result.Parameter?.Value;
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { appId?: string; hmacSecret?: string };
    if (!parsed.appId || !parsed.hmacSecret) return null;
    const dataServerUrl = `${base.replace(/\/+$/, "")}/apps/${appId}`;
    return { appId: parsed.appId, hmacSecret: parsed.hmacSecret, dataServerUrl };
  } catch (err) {
    if (err instanceof ParameterNotFound) return null;
    throw err;
  }
}

export function clearAppCredentialsCache(appId?: string): void {
  if (appId) {
    cache.delete(appId);
    cloudCache.delete(appId);
  } else {
    cache.clear();
    cloudCache.clear();
  }
}
