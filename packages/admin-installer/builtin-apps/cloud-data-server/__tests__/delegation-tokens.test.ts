/**
 * Delegation tokens. A token that verifies must be one this deployment
 * signed, unexpired, with every claim well formed; anything else is null,
 * never a throw.
 */
import { describe, expect, it } from "vitest";
import {
  delegationJwks,
  delegationPublicKeyFromPem,
  delegationSigningKeyFromPem,
  openRefreshToken,
  sealRefreshToken,
  signDelegationToken,
  verifyDelegationToken,
} from "../src/delegation-tokens.js";
import { makeDelegationKeyPem } from "./delegation-key.js";

const pem = makeDelegationKeyPem();
const key = delegationSigningKeyFromPem(pem.privateKeyPem);
const publicKey = delegationPublicKeyFromPem(pem.publicKeyPem);
const NOW = 1_800_000_000_000;

function token(over: Partial<Parameters<typeof signDelegationToken>[1]> = {}) {
  return signDelegationToken(key, {
    userId: "user-1",
    appId: "probe",
    delegationId: "dlg-1",
    mode: "read",
    channel: "app",
    expiresAtMs: NOW + 60_000,
    nowMs: NOW,
    ...over,
  });
}

describe("delegation tokens", () => {
  it("round-trips through the public key alone", () => {
    const t = token();
    expect(t.startsWith("skd_")).toBe(true);
    expect(verifyDelegationToken(t, publicKey, NOW)).toMatchObject({
      sub: "user-1",
      aud: "probe",
      sk_dlg: "dlg-1",
      sk_mode: "read",
      sk_channel: "app",
    });
  });

  it("names the same key id on both halves", () => {
    expect(publicKey.kid).toBe(key.kid);
  });

  it("refuses an expired token", () => {
    expect(verifyDelegationToken(token(), publicKey, NOW + 60_000)).toBeNull();
  });

  it("refuses a token another key signed", () => {
    const other = delegationSigningKeyFromPem(makeDelegationKeyPem().privateKeyPem);
    const forged = signDelegationToken(other, {
      userId: "user-1",
      appId: "probe",
      delegationId: "dlg-1",
      mode: "readwrite",
      channel: "app",
      expiresAtMs: NOW + 60_000,
    });
    expect(verifyDelegationToken(forged, publicKey, NOW)).toBeNull();
    // Even when the forger copies the right key id into the header.
    const [h, p, sig] = forged.slice(4).split(".") as [string, string, string];
    const header = JSON.parse(Buffer.from(h, "base64url").toString());
    const relabeled = Buffer.from(JSON.stringify({ ...header, kid: key.kid })).toString(
      "base64url",
    );
    expect(verifyDelegationToken(`skd_${relabeled}.${p}.${sig}`, publicKey, NOW)).toBeNull();
  });

  it("refuses a token whose claims were changed after signing", () => {
    const [h, p, sig] = token().slice(4).split(".") as [string, string, string];
    const claims = JSON.parse(Buffer.from(p, "base64url").toString());
    const widened = Buffer.from(JSON.stringify({ ...claims, sk_mode: "readwrite" })).toString(
      "base64url",
    );
    expect(verifyDelegationToken(`skd_${h}.${widened}.${sig}`, publicKey, NOW)).toBeNull();
  });

  it("refuses a token without the prefix, and garbage, without throwing", () => {
    expect(verifyDelegationToken(token().slice(4), publicKey, NOW)).toBeNull();
    for (const junk of ["", "skd_", "skd_a.b", "skd_a.b.c", "skd_....", "Bearer x"]) {
      expect(verifyDelegationToken(junk, publicKey, NOW)).toBeNull();
    }
  });

  it("publishes the public key as a JWKS entry", () => {
    const jwks = delegationJwks(publicKey);
    expect(jwks.keys[0]).toMatchObject({ kty: "EC", crv: "P-256", kid: key.kid, alg: "ES256" });
    expect(jwks.keys[0]).not.toHaveProperty("d");
  });
});

describe("sealed refresh tokens", () => {
  it("open with the same key and delegation id", () => {
    const sealed = sealRefreshToken(key.refreshKey, "dlg-1", "refresh-abc");
    expect(sealed).not.toContain("refresh-abc");
    expect(openRefreshToken(key.refreshKey, "dlg-1", sealed)).toBe("refresh-abc");
  });

  it("do not open on another row", () => {
    const sealed = sealRefreshToken(key.refreshKey, "dlg-1", "refresh-abc");
    expect(openRefreshToken(key.refreshKey, "dlg-2", sealed)).toBeNull();
  });

  it("do not open under another deployment's key", () => {
    const other = delegationSigningKeyFromPem(makeDelegationKeyPem().privateKeyPem);
    const sealed = sealRefreshToken(key.refreshKey, "dlg-1", "refresh-abc");
    expect(openRefreshToken(other.refreshKey, "dlg-1", sealed)).toBeNull();
    expect(openRefreshToken(key.refreshKey, "dlg-1", "short")).toBeNull();
  });
});
