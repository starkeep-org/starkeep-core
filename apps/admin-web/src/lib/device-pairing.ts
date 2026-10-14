/**
 * A phone's credential, made in the browser and handed over as a QR code.
 *
 * ## Why the console makes the key
 *
 * Pairing is a phone's install step, and an install mints the credential in
 * the privileged console rather than in the cloud's request path. If the phone
 * made its own key, it would have to send the public half to the cloud before
 * it could authenticate anything, which needs an unauthenticated route and a
 * credential write in the request path (`photos-mobile/mobile-sync-design.md`
 * §4.4). Making the key here needs neither: the public half goes to SSM through
 * Manager, and the private half goes to the phone through its camera.
 *
 * ## Where the private half goes
 *
 * Into the QR code and nowhere else. It is never sent to admin-web's server,
 * never stored, and gone when the page lets go of it. While the code is on
 * screen it is a bearer credential: anyone who photographs it can sync as
 * Starkeep Drive until the device is revoked. The pairing section shows it only
 * after an explicit click and hides it on "Done".
 *
 * ## The formats
 *
 * Web Crypto exports an Ed25519 public key as the 44-byte SPKI the broker
 * already parses, so no conversion happens on that side. The phone signs with
 * `@noble/curves`, which takes the 32-byte RFC 8032 seed. Web Crypto exports
 * the private key as PKCS#8, which for Ed25519 is a fixed 16-byte prefix
 * followed by the seed, so the seed is the last 32 bytes.
 */

/** The version the phone checks for before it reads anything else. */
export const PAIRING_PAYLOAD_VERSION = 1;

/** PKCS#8 for an Ed25519 key, before the 32-byte seed (RFC 8410). */
const ED25519_PKCS8_PREFIX = [
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
];

/** SPKI for an Ed25519 key, before the 32-byte public key (RFC 8410). */
const ED25519_SPKI_PREFIX = [0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00];

export interface DeviceKeys {
  /** A fresh random id, safe in an SSM parameter name. */
  readonly deviceId: string;
  /** Base64 SPKI. Not secret; this is what pairing registers. */
  readonly publicKeySpki: string;
  /** Base64 of the 32-byte Ed25519 seed. The secret, bound for the QR code only. */
  readonly privateKeySeed: string;
}

/** What the phone reads out of the QR code. */
export interface PairingPayload {
  readonly starkeepPair: typeof PAIRING_PAYLOAD_VERSION;
  readonly deviceId: string;
  readonly privateKey: string;
  readonly baseUrl: string;
  readonly label: string | null;
}

/** The crypto this module needs, injectable so a test can supply its own. */
export interface PairingCrypto {
  readonly subtle: Pick<SubtleCrypto, "generateKey" | "exportKey">;
  getRandomValues<T extends ArrayBufferView>(array: T): T;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((b, i) => bytes[i] === b);
}

/**
 * Make a device id and an Ed25519 keypair.
 *
 * Throws when the browser has no Ed25519 in Web Crypto. Every current browser
 * has it, and the pairing section says so rather than pairing nothing.
 */
export async function generateDeviceKeys(crypto: PairingCrypto = globalThis.crypto): Promise<DeviceKeys> {
  // 16 random bytes, base64url: 22 characters of [A-Za-z0-9_-], the alphabet a
  // device id may carry.
  const deviceId = `dev_${toBase64Url(crypto.getRandomValues(new Uint8Array(16)))}`;

  let pair: CryptoKeyPair;
  try {
    pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  } catch (err) {
    throw new Error(
      `This browser cannot make an Ed25519 key (${err instanceof Error ? err.message : String(err)}). Use a current version of Chrome, Firefox or Safari.`,
    );
  }
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));

  // Checked rather than assumed: a browser that wrapped the key differently
  // would otherwise hand the phone 32 bytes that are not its seed, and the
  // phone's every request would fail the signature check with nothing to say
  // why.
  if (spki.length !== 44 || !startsWith(spki, ED25519_SPKI_PREFIX)) {
    throw new Error("The browser exported an Ed25519 public key in an unexpected form");
  }
  if (pkcs8.length !== 48 || !startsWith(pkcs8, ED25519_PKCS8_PREFIX)) {
    throw new Error("The browser exported an Ed25519 private key in an unexpected form");
  }

  return {
    deviceId,
    publicKeySpki: toBase64(spki),
    privateKeySeed: toBase64(pkcs8.slice(16)),
  };
}

/** The QR code's text. */
export function pairingPayload(args: {
  keys: DeviceKeys;
  baseUrl: string;
  label: string | null;
}): string {
  const payload: PairingPayload = {
    starkeepPair: PAIRING_PAYLOAD_VERSION,
    deviceId: args.keys.deviceId,
    privateKey: args.keys.privateKeySeed,
    baseUrl: args.baseUrl,
    label: args.label,
  };
  return JSON.stringify(payload);
}
