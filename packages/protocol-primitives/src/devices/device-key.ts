/**
 * A device's signing key, and the pairing code a device shows its admin.
 *
 * One implementation for every host that holds a device key: the phone and the
 * local data server. The cloud data server verifies with Node's own Ed25519
 * and mirrors the signed message by hand, because it is a separately deployed
 * artifact.
 *
 * ## Why a device has its own key
 *
 * An app's HMAC secret is symmetric, deployment-wide and held by whichever
 * machine installed the app first. A machine holding it *is* the app, a lost
 * machine cannot be cut off without breaking every other client, and a second
 * machine cannot get it at all. So every machine that syncs gets its own
 * Ed25519 key: it signs, the cloud verifies against the public key in the
 * device's record, and revoking a device is deleting that one record.
 *
 * ## The signed message is the HMAC message
 *
 * `${appId}:${METHOD}:${path}:${ts}:` ++ body — byte-identical to what the HMAC
 * scheme signs, so the method binding, the path binding, the replay window and
 * the canonical-path rule are inherited rather than reimplemented. GET and HEAD
 * sign an empty body, because the verifier sees none on those methods.
 *
 * ## Two ways a key reaches the cloud
 *
 * - **Admin-web makes the key** and shows the private half once as a QR code
 *   the phone scans. The phone's own module reads that code.
 * - **The device makes the key** and shows a pairing code: the public half, a
 *   device id, a label and the kind. The admin pastes the code into admin-web,
 *   confirms the fingerprint with the device's owner, and approves it. The
 *   private half never leaves the device. See {@link encodePairingRequest}.
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2";

export const APP_ID_HEADER = "X-Starkeep-App-Id";
export const APP_TS_HEADER = "X-Starkeep-App-Ts";
export const DEVICE_ID_HEADER = "X-Starkeep-Device-Id";
export const DEVICE_SIG_HEADER = "X-Starkeep-Device-Sig";

/**
 * The Drive-channel route a device reads its own record from, relative to
 * `/apps/starkeep-drive`. Answers 401 until an admin approves the device.
 */
export const DEVICE_SELF_ROUTE = "/device/self";

/** Must match the cloud's `isValidDeviceId`; the id becomes an SSM parameter name. */
export const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** The longest label a device may carry. */
export const MAX_DEVICE_LABEL_LENGTH = 100;

/** What kind of machine a device is. The cloud scopes each kind differently. */
export type DeviceKind = "phone" | "desktop";

/** Random bytes, from whatever source the host has: Web Crypto, expo-crypto, node:crypto. */
export type RandomBytes = (length: number) => Uint8Array;

/**
 * The canonical path: the pathname only, percent-decoded. Mirrors
 * `@starkeep/app-client`'s `canonicalSignedPath`, which is Node-only.
 */
export function canonicalSignedPath(path: string): string {
  const q = path.indexOf("?");
  const pathname = q >= 0 ? path.slice(0, q) : path;
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

/** The exact bytes a device signs, and an app HMACs. */
export function signedMessage(
  appId: string,
  method: string,
  path: string,
  ts: number,
  body: Uint8Array | undefined,
): Uint8Array {
  const prefix = new TextEncoder().encode(
    `${appId}:${method.toUpperCase()}:${canonicalSignedPath(path)}:${ts}:`,
  );
  if (!body || body.byteLength === 0) return prefix;
  const out = new Uint8Array(prefix.byteLength + body.byteLength);
  out.set(prefix, 0);
  out.set(body, prefix.byteLength);
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  return fromBase64(padded + "=".repeat((4 - (padded.length % 4)) % 4));
}

/**
 * The 12-byte SPKI prefix for an Ed25519 public key (RFC 8410), so the cloud
 * can import the key with `createPublicKey({ type: "spki", format: "der" })`.
 */
const ED25519_SPKI_PREFIX = new Uint8Array([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);

/** Base64 SPKI of a raw 32-byte Ed25519 public key. */
export function spkiOf(rawPublicKey: Uint8Array): string {
  const out = new Uint8Array(ED25519_SPKI_PREFIX.byteLength + rawPublicKey.byteLength);
  out.set(ED25519_SPKI_PREFIX, 0);
  out.set(rawPublicKey, ED25519_SPKI_PREFIX.byteLength);
  return toBase64(out);
}

/** 32-byte Ed25519 key in a 44-byte SPKI wrapper, base64 — always 60 characters. */
export const SPKI_PATTERN = /^[A-Za-z0-9+/]{59}=$/;

/** A fresh device id: `dev_` and 16 random bytes, base64url. */
export function generateDeviceId(randomBytes: RandomBytes): string {
  return `dev_${toBase64Url(randomBytes(16))}`;
}

/** A fresh 32-byte Ed25519 seed. */
export function generateDeviceSeed(randomBytes: RandomBytes): Uint8Array {
  return randomBytes(32);
}

export interface DeviceSigner {
  readonly deviceId: string;
  /** Base64 SPKI of the public half. Not secret. */
  readonly publicKeySpki: string;
  /**
   * Headers authenticating one request, signed over `path` below the app,
   * as the sync transport signs. `body` must be exactly the bytes sent.
   */
  signRequest(appId: string, method: string, path: string, body: Uint8Array | undefined): Record<string, string>;
}

/** A signer over a 32-byte Ed25519 seed. */
export function deviceSigner(deviceId: string, seed: Uint8Array, now: () => number = Date.now): DeviceSigner {
  if (seed.byteLength !== 32) throw new Error("a device seed is 32 bytes");
  const publicKeySpki = spkiOf(ed25519.getPublicKey(seed));
  return {
    deviceId,
    publicKeySpki,
    signRequest(appId, method, path, body) {
      const ts = now();
      const upper = method.toUpperCase();
      const signedBody = upper === "GET" || upper === "HEAD" ? undefined : body;
      const message = signedMessage(appId, upper, path, ts, signedBody);
      return {
        [APP_ID_HEADER]: appId,
        [APP_TS_HEADER]: String(ts),
        [DEVICE_ID_HEADER]: deviceId,
        [DEVICE_SIG_HEADER]: toBase64(ed25519.sign(message, seed)),
      };
    },
  };
}

/**
 * What the admin reads aloud to confirm a pasted pairing code came from the
 * device in front of its owner: the first 8 hex characters of the SHA-256 of
 * the public key's SPKI bytes, in two groups of four.
 */
export function deviceFingerprint(publicKeySpki: string): string {
  const digest = sha256(fromBase64(publicKeySpki));
  const hex = Array.from(digest.slice(0, 4), (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 4)} ${hex.slice(4, 8)}`;
}

/** The version of the pairing code this build reads and writes. */
export const PAIRING_REQUEST_VERSION = 1;

/** What a device's pairing code carries. Nothing in it is secret. */
export interface PairingRequest {
  readonly deviceId: string;
  readonly publicKeySpki: string;
  readonly label: string | null;
  readonly kind: DeviceKind;
}

/** The pairing code a device shows: base64url JSON, so it survives a paste. */
export function encodePairingRequest(request: PairingRequest): string {
  const json = JSON.stringify({ v: PAIRING_REQUEST_VERSION, ...request });
  return toBase64Url(new TextEncoder().encode(json));
}

export type PairingRequestParse =
  | { readonly ok: true; readonly request: PairingRequest }
  | { readonly ok: false; readonly reason: string };

/** Read a pasted pairing code. Anything can be pasted, so it trusts nothing. */
export function parsePairingRequest(code: string): PairingRequestParse {
  const invalid = { ok: false, reason: "That is not a Starkeep pairing code." } as const;
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(fromBase64Url(code.trim())));
  } catch {
    return invalid;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid;
  const v = value as Record<string, unknown>;
  if (v["v"] === undefined) return invalid;
  if (v["v"] !== PAIRING_REQUEST_VERSION) {
    return { ok: false, reason: "This pairing code is from a different version of Starkeep. Update both, then try again." };
  }
  const deviceId = v["deviceId"];
  if (typeof deviceId !== "string" || !DEVICE_ID_PATTERN.test(deviceId)) {
    return { ok: false, reason: "The pairing code's device id is not valid." };
  }
  const publicKeySpki = v["publicKeySpki"];
  if (typeof publicKeySpki !== "string" || !SPKI_PATTERN.test(publicKeySpki)) {
    return { ok: false, reason: "The pairing code's key is not valid." };
  }
  const label = v["label"];
  if (label !== null && (typeof label !== "string" || label.length > MAX_DEVICE_LABEL_LENGTH)) {
    return { ok: false, reason: "The pairing code's device name is not valid." };
  }
  const kind = v["kind"];
  if (kind !== "phone" && kind !== "desktop") {
    return { ok: false, reason: "The pairing code does not say what kind of device it is." };
  }
  return { ok: true, request: { deviceId, publicKeySpki, label, kind } };
}
