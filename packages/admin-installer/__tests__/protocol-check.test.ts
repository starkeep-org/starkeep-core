/**
 * An app that needs a newer platform protocol is refused at install, with
 * both versions named, before the rest of the manifest is validated.
 */
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initializeLocalSchema } from "@starkeep/storage-sqlite";
import { PROTOCOL_VERSION, parseProtocolVersion } from "@starkeep/protocol-primitives";
import { installLocal, ProtocolVersionError } from "../src/local/installer.js";
import { protocolRefusal } from "../src/protocol-check.js";

const [major, minor] = parseProtocolVersion(PROTOCOL_VERSION)!;
const NEXT_MINOR = `${major}.${minor + 1}.0`;

const MANIFEST = {
  id: "version-app",
  name: "Version App",
  version: "0.1.0",
  tier: "community",
};

function freshDb() {
  const db = new DatabaseSync(":memory:") as never;
  initializeLocalSchema(db);
  return db;
}

describe("protocolRefusal", () => {
  it("passes an app whose requirement the platform meets", () => {
    for (const rawManifest of [MANIFEST, { ...MANIFEST, protocolMinVersion: PROTOCOL_VERSION }]) {
      expect(
        protocolRefusal({
          appId: "version-app",
          rawManifest,
          platformVersion: PROTOCOL_VERSION,
          target: "local",
        }),
      ).toBeNull();
    }
  });

  it("names both versions and says to restart a local data server", () => {
    const refusal = protocolRefusal({
      appId: "version-app",
      rawManifest: { ...MANIFEST, protocolMinVersion: NEXT_MINOR },
      platformVersion: PROTOCOL_VERSION,
      target: "local",
    });
    expect(refusal).toContain(`needs Starkeep protocol ${NEXT_MINOR}`);
    expect(refusal).toContain(`speaks ${PROTOCOL_VERSION}`);
    expect(refusal).toMatch(/restart the local data server/);
  });

  it("refuses against a cloud data server that reports no version", () => {
    const refusal = protocolRefusal({
      appId: "version-app",
      rawManifest: MANIFEST,
      platformVersion: null,
      target: "cloud",
    });
    expect(refusal).toMatch(/reports no protocol version/);
    expect(refusal).toMatch(/redeploy the cloud data server/);
  });

  it("leaves a malformed requirement to validation", () => {
    expect(
      protocolRefusal({
        appId: "version-app",
        rawManifest: { ...MANIFEST, protocolMinVersion: "soon" },
        platformVersion: PROTOCOL_VERSION,
        target: "local",
      }),
    ).toBeNull();
  });
});

describe("installLocal", () => {
  it("refuses a newer requirement before validating the rest of the manifest", () => {
    // A type this platform does not know, as an app written for a newer
    // platform would declare: the version, not the unknown type, is reported.
    const manifest = {
      ...MANIFEST,
      protocolMinVersion: NEXT_MINOR,
      infraRequirements: {
        fileAccess: [{ types: ["future/kind"], access: "read", rationale: "Reads future files." }],
      },
    };
    expect(() => installLocal(freshDb(), manifest)).toThrow(ProtocolVersionError);
  });

  it("installs an app that declares the current version", () => {
    const result = installLocal(freshDb(), { ...MANIFEST, protocolMinVersion: PROTOCOL_VERSION });
    expect(result.appId).toBe("version-app");
  });
});
