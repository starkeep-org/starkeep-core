/**
 * This machine's device key, in `~/.starkeep/device-key.json`.
 *
 * The local data server signs every call to the cloud with this key, so a
 * machine syncs as itself rather than as whichever app's shared secret it
 * happens to hold. The file holds the private seed, so it is written once with
 * mode 0600 and never leaves the machine: pairing sends only the public half,
 * and the cloud accepts the key once an admin approves it.
 *
 * See `~/projects/starkeep/plan-multi-user-roles-2026-10-16.md`, phase 2.
 */

import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEVICE_ID_PATTERN,
  deviceSigner,
  fromBase64,
  generateDeviceId,
  generateDeviceSeed,
  toBase64,
  type DeviceSigner,
} from "@starkeep/protocol-primitives";

export const DEVICE_KEY_FILE = "device-key.json";

interface StoredDeviceKey {
  readonly deviceId: string;
  /** Base64 of the 32-byte Ed25519 seed. */
  readonly seed: string;
  /** What the machine calls itself in its pairing code, or null. */
  readonly label: string | null;
  readonly createdAt: string;
}

/** This machine's key and the name its pairing code carries. */
export interface LocalDeviceKey {
  readonly signer: DeviceSigner;
  readonly label: string | null;
}

const nodeRandomBytes = (length: number): Uint8Array => new Uint8Array(randomBytes(length));

/**
 * This machine's key, or null when it has none. A file that does not parse
 * counts as none, and the error says so in the log: making a new key would
 * orphan the approved one, so that is left to the operator.
 */
export function loadDeviceKeyFile(dir: string): LocalDeviceKey | null {
  let raw: string;
  try {
    raw = readFileSync(join(dir, DEVICE_KEY_FILE), "utf8");
  } catch {
    return null;
  }
  try {
    const stored = JSON.parse(raw) as Partial<StoredDeviceKey>;
    if (typeof stored.deviceId !== "string" || !DEVICE_ID_PATTERN.test(stored.deviceId)) {
      throw new Error("the device id is not valid");
    }
    if (typeof stored.seed !== "string") throw new Error("the seed is missing");
    return {
      signer: deviceSigner(stored.deviceId, fromBase64(stored.seed)),
      label: typeof stored.label === "string" ? stored.label : null,
    };
  } catch (err) {
    console.error(`[device] ${DEVICE_KEY_FILE} is unreadable, so this machine cannot sync: ${String(err)}`);
    return null;
  }
}

/**
 * Make this machine's key. Refuses to overwrite an existing file, because the
 * key in it may already be approved and a new key would need approving again.
 */
export function createDeviceKeyFile(dir: string, label: string | null): LocalDeviceKey {
  const deviceId = generateDeviceId(nodeRandomBytes);
  const seed = generateDeviceSeed(nodeRandomBytes);
  const stored: StoredDeviceKey = { deviceId, seed: toBase64(seed), label, createdAt: new Date().toISOString() };
  writeFileSync(join(dir, DEVICE_KEY_FILE), `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  return { signer: deviceSigner(deviceId, seed), label };
}
