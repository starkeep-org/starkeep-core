/**
 * What a device needs to sign in, learned from the cloud's address alone.
 *
 * A member's desktop or phone knows only the cloud address the admin sent. The
 * cloud data server answers `GET /auth/config` with the region, the user pool,
 * the device client's id, the mobile-apps client's id and the managed login
 * page's host name. Every value is public: a client id is not a secret, and
 * the pool id is in every token the pool issues.
 */

/** The cloud data server's public discovery route. */
export const AUTH_CONFIG_ROUTE = "/auth/config";

/**
 * The platform's sign-in pages for cloud apps, on the shared origin outside
 * every app's `/apps/<appId>` path. `start` sends the browser to the managed
 * login page, `callback` receives it back and sets the app's session cookies,
 * `sign-out` clears them and ends the managed login session, and Cognito
 * returns the browser to `signed-out` afterwards.
 */
export const AUTH_START_ROUTE = "/auth/start";
export const AUTH_CALLBACK_ROUTE = "/auth/callback";
export const AUTH_SIGN_OUT_ROUTE = "/auth/sign-out";
export const AUTH_SIGNED_OUT_ROUTE = "/auth/signed-out";

/**
 * Where a mobile app registers its attested key, under Drive's path:
 * `POST /apps/starkeep-drive/mobile/keys`.
 */
export const MOBILE_KEYS_ROUTE = "/mobile/keys";

export interface DeviceAuthConfig {
  readonly region: string;
  readonly userPoolId: string;
  readonly deviceClientId: string;
  /**
   * The managed login page's host name, where a desktop signs in. Absent from
   * a cloud that predates browser sign-in; the local data server then falls
   * back to the `cognitoDomain` in its own config.
   */
  readonly cognitoDomain?: string;
}

/**
 * Where the browser returns after a sign-in on the managed login page.
 * Cognito matches callback URLs exactly, port included, so the bootstrap
 * template lists both: admin-web's own route on its default port, and the
 * CLI's one-shot listener on a fixed port from the unassigned range.
 */
export const ADMIN_WEB_DEFAULT_PORT = 3000;
export const ADMIN_WEB_CALLBACK_PATH = "/auth/callback";
export const CLI_CALLBACK_PORT = 47615;
export const CLI_CALLBACK_PATH = "/callback";

/** The callback URLs the admin and device clients accept, in template order. */
export function localCallbackUrls(): string[] {
  return [
    `http://localhost:${ADMIN_WEB_DEFAULT_PORT}${ADMIN_WEB_CALLBACK_PATH}`,
    `http://localhost:${CLI_CALLBACK_PORT}${CLI_CALLBACK_PATH}`,
  ];
}

/** A bare host name: the page's address is built from it, so no scheme, path or port. */
export function isCognitoDomain(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(value);
}

/**
 * What a mobile app needs to sign in: the managed login page's host name and
 * the mobile-apps client. A mobile app signs in on the page, never with a
 * password of its own.
 */
export interface MobileAuthConfig {
  readonly region: string;
  readonly userPoolId: string;
  readonly mobileClientId: string;
  readonly cognitoDomain: string;
}

/**
 * The mobile half of a discovery answer, or null when the cloud has no
 * mobile-apps client yet.
 */
export function parseMobileAuthConfig(value: unknown): MobileAuthConfig | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const { region, userPoolId, mobileClientId, cognitoDomain } = v;
  if (typeof region !== "string" || !/^[a-z]{2}(-[a-z]+)+-\d$/.test(region)) return null;
  if (typeof userPoolId !== "string" || !userPoolId.startsWith(`${region}_`)) return null;
  if (typeof mobileClientId !== "string" || !/^[A-Za-z0-9]{1,128}$/.test(mobileClientId))
    return null;
  // A bare host name: the page's address is built from it, so a scheme, a
  // path or a port here would send the sign-in somewhere else.
  if (!isCognitoDomain(cognitoDomain)) return null;
  return { region, userPoolId, mobileClientId, cognitoDomain };
}

/** Read a discovery answer. It came over the network, so it trusts nothing. */
export function parseDeviceAuthConfig(value: unknown): DeviceAuthConfig | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const { region, userPoolId, deviceClientId, cognitoDomain } = v;
  if (typeof region !== "string" || !/^[a-z]{2}(-[a-z]+)+-\d$/.test(region)) return null;
  if (typeof userPoolId !== "string" || !userPoolId.startsWith(`${region}_`)) return null;
  if (typeof deviceClientId !== "string" || !/^[A-Za-z0-9]{1,128}$/.test(deviceClientId))
    return null;
  // A malformed domain is dropped rather than failing the whole answer: the
  // device can still refresh a session it holds without the page.
  return isCognitoDomain(cognitoDomain)
    ? { region, userPoolId, deviceClientId, cognitoDomain }
    : { region, userPoolId, deviceClientId };
}

/** Ask a cloud how its mobile apps sign in. Throws when the cloud cannot answer. */
export async function fetchMobileAuthConfig(
  cloudUrl: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<MobileAuthConfig> {
  const res = await fetchImpl(`${cloudUrl.replace(/\/+$/, "")}${AUTH_CONFIG_ROUTE}`);
  if (!res.ok) throw new Error(`The cloud answered ${res.status} when asked how to sign in`);
  const config = parseMobileAuthConfig(await res.json());
  if (!config) throw new Error("This cloud does not offer sign-in to mobile apps yet");
  return config;
}

/** Ask a cloud how its devices sign in. Throws when the cloud cannot answer. */
export async function fetchDeviceAuthConfig(
  cloudUrl: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<DeviceAuthConfig> {
  const res = await fetchImpl(`${cloudUrl.replace(/\/+$/, "")}${AUTH_CONFIG_ROUTE}`);
  if (!res.ok) throw new Error(`The cloud answered ${res.status} when asked how to sign in`);
  const config = parseDeviceAuthConfig(await res.json());
  if (!config) throw new Error("The cloud's sign-in settings are incomplete");
  return config;
}
