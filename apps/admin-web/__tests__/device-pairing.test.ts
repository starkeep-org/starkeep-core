/**
 * The phone's credential, made by the browser.
 *
 * The one new piece of crypto glue in QR pairing is the seed: Web Crypto
 * exports the private key as PKCS#8, the phone signs from the raw 32-byte seed
 * with `@noble/curves`, and the broker verifies against the SPKI with
 * `node:crypto`. These tests generate with Web Crypto, sign the way the phone
 * does, and verify the way the broker does. Three implementations across the
 * wire is the point: a test that generated, signed and verified with one
 * library would prove nothing about the pairing that ships.
 */
import { describe, expect, it } from "vitest";
import { createPublicKey, verify } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  generateDeviceKeys,
  pairingPayload,
  PAIRING_PAYLOAD_VERSION,
  type PairingCrypto,
} from "../src/lib/device-pairing";

const fromBase64 = (text: string) => Uint8Array.from(Buffer.from(text, "base64"));

describe("generating a device's keys", () => {
  it("makes a device id the broker and the settings file both accept", async () => {
    const { deviceId } = await generateDeviceKeys();
    expect(deviceId).toMatch(/^dev_[A-Za-z0-9_-]{22}$/);
    expect(deviceId).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
  });

  it("makes a fresh id and key every time", async () => {
    const a = await generateDeviceKeys();
    const b = await generateDeviceKeys();
    expect(a.deviceId).not.toBe(b.deviceId);
    expect(a.privateKeySeed).not.toBe(b.privateKeySeed);
  });

  it("exports the public key in the 60-character SPKI form pairing validates", async () => {
    const { publicKeySpki } = await generateDeviceKeys();
    expect(publicKeySpki).toMatch(/^[A-Za-z0-9+/]{59}=$/);
  });

  it("exports a 32-byte seed from which the phone derives the same public key", async () => {
    const keys = await generateDeviceKeys();
    const seed = fromBase64(keys.privateKeySeed);
    expect(seed.length).toBe(32);
    const rawPublic = fromBase64(keys.publicKeySpki).slice(12);
    expect(Buffer.from(ed25519.getPublicKey(seed)).equals(Buffer.from(rawPublic))).toBe(true);
  });

  it("signs, from the seed, what the broker verifies against the SPKI", async () => {
    const keys = await generateDeviceKeys();
    const message = new TextEncoder().encode("starkeep-drive:POST:/sync/exchange:1760000000000:{}");
    const signature = ed25519.sign(message, fromBase64(keys.privateKeySeed));

    // How the broker verifies: a node:crypto public key from the SPKI bytes.
    const publicKey = createPublicKey({ key: Buffer.from(keys.publicKeySpki, "base64"), format: "der", type: "spki" });
    expect(verify(null, message, publicKey, signature)).toBe(true);
    expect(verify(null, new TextEncoder().encode("tampered"), publicKey, signature)).toBe(false);
  });

  it("explains a browser without Ed25519 rather than failing obscurely", async () => {
    const noEd25519: PairingCrypto = {
      subtle: {
        generateKey: () => Promise.reject(new Error("Unrecognized name")),
        exportKey: () => Promise.reject(new Error("unreachable")),
      } as unknown as PairingCrypto["subtle"],
      getRandomValues: (a) => globalThis.crypto.getRandomValues(a),
    };
    await expect(generateDeviceKeys(noEd25519)).rejects.toThrow(/cannot make an Ed25519 key.*Unrecognized name/);
  });

  it("refuses a private key wrapped in an unexpected form, rather than handing the phone a wrong seed", async () => {
    const odd: PairingCrypto = {
      subtle: {
        generateKey: (...args: Parameters<SubtleCrypto["generateKey"]>) =>
          globalThis.crypto.subtle.generateKey(...(args as [AlgorithmIdentifier, boolean, KeyUsage[]])),
        exportKey: async (format: string, key: CryptoKey) => {
          const out = await globalThis.crypto.subtle.exportKey(format as "spki", key);
          // A 49-byte PKCS#8, as an encoder that added an attribute might emit.
          return format === "pkcs8" ? new Uint8Array([...new Uint8Array(out), 0]).buffer : out;
        },
      } as unknown as PairingCrypto["subtle"],
      getRandomValues: (a) => globalThis.crypto.getRandomValues(a),
    };
    await expect(generateDeviceKeys(odd)).rejects.toThrow(/private key in an unexpected form/);
  });
});

describe("the QR payload", () => {
  it("carries the version, the id, the seed, the cloud URL and the label, and no public key", async () => {
    const keys = await generateDeviceKeys();
    const text = pairingPayload({ keys, baseUrl: "https://d123.cloudfront.net", label: "Pixel 9" });
    expect(JSON.parse(text)).toEqual({
      starkeepPair: PAIRING_PAYLOAD_VERSION,
      deviceId: keys.deviceId,
      privateKey: keys.privateKeySeed,
      baseUrl: "https://d123.cloudfront.net",
      label: "Pixel 9",
    });
  });

  it("stays small enough for a QR code a phone camera reads at a glance", async () => {
    const keys = await generateDeviceKeys();
    const text = pairingPayload({
      keys,
      baseUrl: "https://abcdefghij.execute-api.us-east-2.amazonaws.com",
      label: "x".repeat(100),
    });
    expect(text.length).toBeLessThan(400);
  });
});
