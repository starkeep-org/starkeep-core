/**
 * The credential vault: one user's secrets for your app's third-party
 * services, such as a provider's refresh token or an API key, kept by the
 * platform in the cloud.
 *
 * Your app's server stores a secret the user types (`putSecret` with the
 * user's token), lists the user's secrets (`listSecrets`) and deletes one
 * (`deleteSecret`). The browser never reads a secret back. A run of one of
 * your scheduled jobs reads the secret for its user (`readSecret` with the
 * run's token) and may write a rotated value (`putSecret` with the run's
 * token). Every call goes through `signedFetch`, so the platform knows which
 * app is asking.
 *
 * The vault lives in the cloud only. On the local surface every call reports
 * `cloudRequired`.
 */

import { loadAppCredentials, type AppCredentials } from "./credentials";
import { signedFetch, USER_TOKEN_HEADER } from "./sign";

/** One secret as a listing shows it: never its value. */
export interface SecretEntry {
  name: string;
  /** Milliseconds since the epoch. */
  updatedAt: number | null;
}

/** Who a vault call acts for: the signed-in user, or a job run. */
export type VaultCaller =
  | { userToken: string | null; creds?: AppCredentials }
  | { delegation: string; creds?: AppCredentials };

/** How a vault call ended. */
export type VaultResult<T> =
  | { ok: true; value: T }
  | { ok: false; cloudRequired: true }
  | { ok: false; cloudRequired: false; status: number; error: string };

async function call(
  appId: string,
  path: string,
  caller: VaultCaller,
  init: { method: string; body?: string },
): Promise<Response> {
  const creds = caller.creds ?? (await loadAppCredentials(appId));
  if (!creds) throw new Error(`${appId} is not installed on this surface`);
  const headers: Record<string, string> =
    "delegation" in caller ? {} : caller.userToken ? { [USER_TOKEN_HEADER]: caller.userToken } : {};
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  return await signedFetch(creds, path, {
    method: init.method,
    headers,
    ...(init.body !== undefined ? { body: init.body } : {}),
    ...("delegation" in caller ? { delegation: caller.delegation } : {}),
  });
}

async function resultOf<T>(res: Response, read: (body: unknown) => T): Promise<VaultResult<T>> {
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (res.status === 501 && body?.code === "cloud-required")
    return { ok: false, cloudRequired: true };
  if (res.ok) return { ok: true, value: read(body) };
  return {
    ok: false,
    cloudRequired: false,
    status: res.status,
    error: typeof body?.error === "string" ? body.error : `The vault answered ${res.status}`,
  };
}

const secretPath = (name: string) => `/vault/${encodeURIComponent(name)}`;

/** The signed-in user's secrets for the app: names and times only. */
export async function listSecrets(
  appId: string,
  caller: { userToken: string | null; creds?: AppCredentials },
): Promise<VaultResult<SecretEntry[]>> {
  const res = await call(appId, "/vault", caller, { method: "GET" });
  return resultOf(res, (b) => (b as { secrets: SecretEntry[] }).secrets);
}

/**
 * Store or replace one secret, for the signed-in user or for a job run's
 * user. A name is lowercase letters, digits, `_` and `-`, at most 64
 * characters, and a value holds at most 4,096 bytes.
 */
export async function putSecret(
  appId: string,
  name: string,
  value: string,
  caller: VaultCaller,
): Promise<VaultResult<null>> {
  const res = await call(appId, secretPath(name), caller, {
    method: "PUT",
    body: JSON.stringify({ value }),
  });
  return resultOf(res, () => null);
}

/** Delete one of the signed-in user's secrets. */
export async function deleteSecret(
  appId: string,
  name: string,
  caller: { userToken: string | null; creds?: AppCredentials },
): Promise<VaultResult<null>> {
  const res = await call(appId, secretPath(name), caller, { method: "DELETE" });
  return resultOf(res, () => null);
}

/** Read one secret's value, from a job run, for the run's user. Null when absent. */
export async function readSecret(
  appId: string,
  name: string,
  caller: { delegation: string; creds?: AppCredentials },
): Promise<VaultResult<string | null>> {
  const res = await call(appId, secretPath(name), caller, { method: "GET" });
  if (res.status === 404) return { ok: true, value: null };
  return resultOf(res, (b) => (b as { value: string }).value);
}
