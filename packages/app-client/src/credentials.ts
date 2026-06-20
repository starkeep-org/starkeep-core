import { existsSync, readFileSync } from "node:fs";
import { appCredsPath } from "./paths";

export interface AppCredentials {
  appId: string;
  hmacSecret: string;
  dataServerUrl: string;
}

export function appCredentialsPath(appId: string): string {
  return appCredsPath(appId);
}

// Per-process credential cache, keyed by appId. Stores the in-flight (and
// settled) promise so concurrent callers share one SSM fetch / file read. The
// underlying source (SSM parameter in cloud mode, creds file in local mode) is
// rewritten only on install/uninstall, so caching for the process lifetime is
// safe; call `clearAppCredentialsCache` after an install to pick up a rotation.
const cache = new Map<string, Promise<AppCredentials | null>>();

/**
 * Load an app's credentials. The single credential entry point for both modes:
 *
 * - Cloud mode (`STARKEEP_APP_CLIENT_MODE=cloud`): fetches the HMAC secret from
 *   SSM via the Lambda's exec role; the data-server URL is derived from
 *   `STARKEEP_CLOUD_DATA_BASE`.
 * - Local mode (default): reads `~/.starkeep/app-creds/${appId}.json`, written
 *   by admin-web at install time.
 *
 * Always async — SSM has no synchronous API, and every caller runs inside an
 * async request handler — so there is no way to silently get `null` in cloud
 * mode by picking a sync loader.
 */
export async function loadAppCredentials(
  appId: string,
): Promise<AppCredentials | null> {
  const existing = cache.get(appId);
  if (existing) return existing;
  const promise = (
    clientMode() === "cloud"
      ? fetchCloudCredentials(appId)
      : loadLocalCredentials(appId)
  ).catch((err) => {
    // Don't cache a transient failure (e.g. an SSM throttle); let the next
    // call retry. A resolved `null` (genuinely not installed) stays cached.
    cache.delete(appId);
    throw err;
  });
  cache.set(appId, promise);
  return promise;
}

async function loadLocalCredentials(appId: string): Promise<AppCredentials | null> {
  const path = appCredentialsPath(appId);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<AppCredentials>;
    if (!parsed.appId || !parsed.hmacSecret) return null;
    return {
      appId: parsed.appId,
      hmacSecret: parsed.hmacSecret,
      dataServerUrl: parsed.dataServerUrl ?? "http://127.0.0.1:9820",
    };
  } catch {
    return null;
  }
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
  } else {
    cache.clear();
  }
}
