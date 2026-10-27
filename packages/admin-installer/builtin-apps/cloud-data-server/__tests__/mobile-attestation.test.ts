/**
 * The attestation check: what a phone must prove before its key may sign for
 * an app. Each refusal here is one way a hostile app, a modified device or a
 * replayed attestation could otherwise borrow another app's grants.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SecurityLevel, VerifiedBootState } from "@peculiar/asn1-android";
import {
  appForAttestedKey,
  normalizeSerial,
  verifyAttestation,
  type AttestationPolicy,
} from "../src/mobile-attestation.js";
import { GOOGLE_ATTESTATION_ROOTS } from "../src/attestation-roots.js";
import { TEST_CERT_DIGEST, TEST_PACKAGE, testAuthority } from "./attestation-chain.js";

const authority = testAuthority();
const challenge = createHash("sha256").update("the id token").digest();
const policy: AttestationPolicy = { roots: [authority.rootPem], isRevoked: () => false };

describe("verifyAttestation", () => {
  it("accepts a hardware key on a locked, verified device and reports the app", () => {
    const { chain, key } = authority.chain({ challenge });
    const result = verifyAttestation(chain, challenge, policy);
    expect(result).toMatchObject({
      ok: true,
      key: {
        packageName: TEST_PACKAGE,
        signingCertDigests: [TEST_CERT_DIGEST],
        securityLevel: "tee",
      },
    });
    const spki = key.publicKey.export({ type: "spki", format: "der" });
    expect(result.ok && result.key.keyId).toBe(createHash("sha256").update(spki).digest("hex"));
  });

  it("reports StrongBox keys as such", () => {
    const { chain } = authority.chain({ challenge, securityLevel: SecurityLevel.strongBox });
    const result = verifyAttestation(chain, challenge, policy);
    expect(result.ok && result.key.securityLevel).toBe("strongbox");
  });

  const refusals: Array<[string, Parameters<typeof authority.chain>[0], RegExp]> = [
    ["a software key", { challenge, securityLevel: SecurityLevel.software }, /secure hardware/],
    ["an unlocked bootloader", { challenge, deviceLocked: false }, /unlocked/],
    ["an unverified OS", { challenge, bootState: VerifiedBootState.unverified }, /not verified/],
    ["an imported key", { challenge, origin: 2 }, /imported/],
    ["a key that may not sign", { challenge, purposes: [0] }, /may not sign/],
    ["a key made for another sign-in", { challenge: Buffer.alloc(32, 7) }, /another sign-in/],
    ["apps sharing a user id", { challenge, extraPackages: ["com.other"] }, /more than one/],
  ];
  for (const [label, claims, reason] of refusals) {
    it(`refuses ${label}`, () => {
      const { chain } = authority.chain(claims);
      const result = verifyAttestation(chain, challenge, policy);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.reason).toMatch(reason);
    });
  }

  it("refuses a chain from a root it does not pin, Google's included", () => {
    const { chain } = testAuthority("Another Root").chain({ challenge });
    expect(verifyAttestation(chain, challenge, policy).ok).toBe(false);
    expect(
      verifyAttestation(authority.chain({ challenge }).chain, challenge, {
        roots: GOOGLE_ATTESTATION_ROOTS,
        isRevoked: () => false,
      }).ok,
    ).toBe(false);
  });

  it("refuses a chain with a link out of order", () => {
    const { chain } = authority.chain({ challenge });
    expect(verifyAttestation([chain[0]!, chain[2]!], challenge, policy).ok).toBe(false);
  });

  it("refuses a chain with a revoked certificate", () => {
    const { chain } = authority.chain({ challenge });
    const result = verifyAttestation(chain, challenge, {
      ...policy,
      isRevoked: (serial) => serial === "2",
    });
    expect(!result.ok && result.reason).toMatch(/revoked/);
  });

  it("refuses an intermediate out of date", () => {
    const { chain } = authority.chain({ challenge });
    const result = verifyAttestation(chain, challenge, { ...policy, now: new Date("2050-01-01") });
    expect(!result.ok && result.reason).toMatch(/out of date/);
  });

  it("refuses a lone certificate and garbage", () => {
    const { chain } = authority.chain({ challenge });
    expect(verifyAttestation([chain[0]!], challenge, policy).ok).toBe(false);
    expect(verifyAttestation([Buffer.from("x"), chain[1]!], challenge, policy).ok).toBe(false);
  });
});

describe("appForAttestedKey", () => {
  const key = {
    keyId: "k",
    publicKey: "p",
    packageName: TEST_PACKAGE,
    signingCertDigests: [TEST_CERT_DIGEST],
    securityLevel: "tee" as const,
  };
  const photos = { appId: "photos", androidPackage: TEST_PACKAGE, certDigests: [TEST_CERT_DIGEST] };

  it("maps a package and certificate to the one app that declared them", () => {
    expect(appForAttestedKey(key, [photos])).toBe("photos");
  });

  it("refuses an unknown package or a certificate the manifest does not list", () => {
    expect(appForAttestedKey({ ...key, packageName: "com.evil" }, [photos])).toBeNull();
    expect(
      appForAttestedKey({ ...key, signingCertDigests: ["ab".repeat(32)] }, [photos]),
    ).toBeNull();
  });

  it("refuses when two apps claim the same build", () => {
    expect(appForAttestedKey(key, [photos, { ...photos, appId: "photos-copy" }])).toBeNull();
  });
});

describe("normalizeSerial", () => {
  it("matches the revocation list's spelling", () => {
    expect(normalizeSerial("00E8FA19")).toBe("e8fa19");
    expect(normalizeSerial("0")).toBe("0");
  });
});
