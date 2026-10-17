import { describe, expect, it } from "vitest";
import { createPublicKey, randomBytes as nodeRandomBytes, verify } from "node:crypto";
import {
  DEVICE_ID_PATTERN,
  deviceFingerprint,
  deviceSigner,
  encodePairingRequest,
  generateDeviceId,
  generateDeviceSeed,
  parsePairingRequest,
  signedMessage,
  SPKI_PATTERN,
} from "../src/index.js";

const randomBytes = (n: number) => new Uint8Array(nodeRandomBytes(n));

describe("deviceSigner", () => {
  it("signs the HMAC message, which Node's Ed25519 verifies against the SPKI", () => {
    const signer = deviceSigner("dev_test", generateDeviceSeed(randomBytes), () => 1_700_000_000_000);
    expect(signer.publicKeySpki).toMatch(SPKI_PATTERN);
    const body = new TextEncoder().encode('{"a":1}');
    const headers = signer.signRequest("starkeep-drive", "post", "/sync/exchange", body);
    expect(headers["X-Starkeep-App-Id"]).toBe("starkeep-drive");
    expect(headers["X-Starkeep-Device-Id"]).toBe("dev_test");
    expect(headers["X-Starkeep-App-Ts"]).toBe("1700000000000");

    const key = createPublicKey({ key: Buffer.from(signer.publicKeySpki, "base64"), type: "spki", format: "der" });
    const message = Buffer.from(`starkeep-drive:POST:/sync/exchange:1700000000000:{"a":1}`, "utf8");
    expect(verify(null, message, key, Buffer.from(headers["X-Starkeep-Device-Sig"]!, "base64"))).toBe(true);
  });

  it("signs an empty body on GET and HEAD, whatever it is handed", () => {
    const signer = deviceSigner("dev_test", generateDeviceSeed(randomBytes), () => 5);
    const headers = signer.signRequest("photos", "GET", "/files/a%2Fb/stat", new Uint8Array([1, 2]));
    const key = createPublicKey({ key: Buffer.from(signer.publicKeySpki, "base64"), type: "spki", format: "der" });
    const message = Buffer.from(signedMessage("photos", "GET", "/files/a/b/stat", 5, undefined));
    expect(verify(null, message, key, Buffer.from(headers["X-Starkeep-Device-Sig"]!, "base64"))).toBe(true);
  });

  it("refuses a seed that is not 32 bytes", () => {
    expect(() => deviceSigner("dev_x", new Uint8Array(16))).toThrow(/32 bytes/);
  });
});

describe("generated ids", () => {
  it("make ids the cloud accepts as parameter names", () => {
    for (let i = 0; i < 20; i += 1) expect(generateDeviceId(randomBytes)).toMatch(DEVICE_ID_PATTERN);
  });
});

describe("deviceFingerprint", () => {
  it("is eight hex characters in two groups, stable for one key and different for another", () => {
    const a = deviceSigner("dev_a", generateDeviceSeed(randomBytes)).publicKeySpki;
    const b = deviceSigner("dev_b", generateDeviceSeed(randomBytes)).publicKeySpki;
    expect(deviceFingerprint(a)).toMatch(/^[0-9a-f]{4} [0-9a-f]{4}$/);
    expect(deviceFingerprint(a)).toBe(deviceFingerprint(a));
    expect(deviceFingerprint(a)).not.toBe(deviceFingerprint(b));
  });
});

describe("pairing codes", () => {
  const request = {
    deviceId: "dev_abc-123",
    publicKeySpki: deviceSigner("dev_abc-123", generateDeviceSeed(randomBytes)).publicKeySpki,
    label: "Sam's laptop",
    kind: "desktop" as const,
  };

  it("round-trip, and survive surrounding whitespace from a paste", () => {
    const code = encodePairingRequest(request);
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(parsePairingRequest(`  ${code}\n`)).toEqual({ ok: true, request });
  });

  it.each([
    ["not base64 JSON", "!!!"],
    ["a JSON value with no version", encodeRaw({ deviceId: "dev_a" })],
    ["a newer version", encodeRaw({ ...request, v: 2 })],
    ["a device id that walks a path", encodeRaw({ ...request, v: 1, deviceId: "../app-creds/x" })],
    ["a key that is not SPKI", encodeRaw({ ...request, v: 1, publicKeySpki: "abc" })],
    ["a label that is too long", encodeRaw({ ...request, v: 1, label: "x".repeat(101) })],
    ["an unknown kind", encodeRaw({ ...request, v: 1, kind: "tablet" })],
  ])("refuse %s", (_name, code) => {
    expect(parsePairingRequest(code).ok).toBe(false);
  });
});

function encodeRaw(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
