/**
 * What a device needs to sign in, learned from the cloud's address alone.
 *
 * A member's desktop or phone knows only the cloud address the admin sent. The
 * cloud data server answers `GET /auth/config` with the region, the user pool
 * and the device client's id. Every value is public: a client id is not a
 * secret, and the pool id is in every token the pool issues.
 */

/** The cloud data server's public discovery route. */
export const AUTH_CONFIG_ROUTE = "/auth/config";

export interface DeviceAuthConfig {
  readonly region: string;
  readonly userPoolId: string;
  readonly deviceClientId: string;
}

/** Read a discovery answer. It came over the network, so it trusts nothing. */
export function parseDeviceAuthConfig(value: unknown): DeviceAuthConfig | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const { region, userPoolId, deviceClientId } = v;
  if (typeof region !== "string" || !/^[a-z]{2}(-[a-z]+)+-\d$/.test(region)) return null;
  if (typeof userPoolId !== "string" || !userPoolId.startsWith(`${region}_`)) return null;
  if (typeof deviceClientId !== "string" || !/^[A-Za-z0-9]{1,128}$/.test(deviceClientId)) return null;
  return { region, userPoolId, deviceClientId };
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
