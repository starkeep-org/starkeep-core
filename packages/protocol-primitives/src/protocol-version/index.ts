/**
 * The version of the contract between the platform and an app: the data
 * routes, the file types, the manifest fields, and what
 * `@starkeep/app-client` expects of a data server.
 *
 * The version follows semver with two kinds of bump:
 *
 * - **Minor** for an addition an app can depend on: a file type, a route, a
 *   manifest field, a response field.
 * - **Major** for a change that breaks an app written against an earlier
 *   version.
 *
 * Bump the constant in the change that adds or breaks the contract. An app
 * declares the lowest version it needs in its manifest's
 * `protocolMinVersion`, and both installers refuse an app whose requirement
 * this platform does not meet. Both data servers report the constant on
 * `GET /health` as `protocolVersion`.
 */
export const PROTOCOL_VERSION = "1.0.0";

/** A protocol version as `[major, minor, patch]`, or null when malformed. */
export function parseProtocolVersion(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Whether a platform at protocol version `platform` serves an app that needs
 * `required`: the major versions match, and the platform is at least as new.
 * A malformed version on either side never satisfies.
 */
export function protocolSatisfies(required: string, platform: string): boolean {
  const need = parseProtocolVersion(required);
  const have = parseProtocolVersion(platform);
  if (!need || !have) return false;
  if (need[0] !== have[0]) return false;
  if (have[1] !== need[1]) return have[1] > need[1];
  return have[2] >= need[2];
}
