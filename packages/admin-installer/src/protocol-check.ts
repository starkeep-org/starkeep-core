/**
 * The install-time check of an app's `protocolMinVersion` against the
 * platform's protocol version. Both installers run it before they validate
 * the rest of the manifest, because an app written for a newer platform
 * usually also fails validation on an older one (a file type or manifest
 * field the older validator does not know), and the version mismatch is the
 * message that tells the operator what to do.
 */

import { parseProtocolVersion, protocolSatisfies } from "@starkeep/protocol-primitives";

/** The data server whose protocol version the app is checked against. */
export type ProtocolCheckTarget = "local" | "cloud";

/**
 * Why `appId` cannot install against a data server at `platformVersion`, or
 * null when it can. `platformVersion` is null for a data server that reports
 * no version, which predates the check. A manifest whose
 * `protocolMinVersion` is missing or malformed passes here; the default
 * applies to a missing value, and validation reports a malformed one.
 */
export function protocolRefusal(opts: {
  appId: string;
  rawManifest: unknown;
  platformVersion: string | null;
  target: ProtocolCheckTarget;
}): string | null {
  const raw =
    typeof opts.rawManifest === "object" && opts.rawManifest !== null
      ? (opts.rawManifest as { protocolMinVersion?: unknown }).protocolMinVersion
      : undefined;
  const required = typeof raw === "string" ? raw : "1.0.0";
  if (parseProtocolVersion(required) === null) return null;
  if (opts.platformVersion !== null && protocolSatisfies(required, opts.platformVersion)) {
    return null;
  }
  const server =
    opts.target === "local" ? "this computer's local data server" : "the cloud data server";
  const speaks =
    opts.platformVersion === null
      ? `${server} reports no protocol version, so it predates version checks`
      : `${server} speaks ${opts.platformVersion}`;
  // A platform on a later major version has dropped the contract the app was
  // written against, so the app needs the update, not the platform.
  const platformMajor =
    opts.platformVersion === null ? null : parseProtocolVersion(opts.platformVersion)?.[0];
  const remedy =
    platformMajor != null && platformMajor > parseProtocolVersion(required)![0]
      ? `The app was written for an older protocol; install a version of ${opts.appId} built for protocol ${platformMajor}.x.`
      : opts.target === "local"
        ? "Update the starkeep-core checkout and restart the local data server; a data server started before a pull keeps running its old code."
        : "Update the starkeep-core checkout and redeploy the cloud data server.";
  return `${opts.appId} needs Starkeep protocol ${required}, and ${speaks}. ${remedy}`;
}
