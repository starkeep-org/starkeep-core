/**
 * Mobile apps' attested keys: registering one, and checking a request signed
 * with one.
 *
 * A mobile app signs in through the public mobile-apps client, so its token
 * says who the user is but not which app holds it. After each sign-in the app
 * registers a Keystore key whose attestation names the app
 * (`mobile-attestation.ts`). The broker maps the attestation to the one app
 * whose manifest declared that Android build, and stores
 * `{ keyId, userId, appId, publicKey, registeredAt }`. Every later request
 * carries the user's token and a signature by that key, and acts with that
 * app's grants alone.
 *
 * The attestation's challenge must be SHA-256 of the ID token presented with
 * it. That binds the key to a live sign-in without any challenge state on the
 * server: a captured attestation is useless with another token, and a token
 * expires in fifteen minutes.
 */
import { createHash, verify } from "node:crypto";
import {
  GetParameterCommand,
  ParameterAlreadyExists,
  ParameterNotFound,
  PutParameterCommand,
  type SSMClient,
} from "@aws-sdk/client-ssm";
import { mobileSignedMessage } from "@starkeep/protocol-primitives";
import {
  appForAttestedKey,
  publicKeyFrom,
  verifyAttestation,
  type MobileIdentity,
} from "./mobile-attestation.js";
import { GOOGLE_ATTESTATION_ROOTS } from "./attestation-roots.js";

/** What the broker keeps for one attested key. */
export interface MobileKeyRecord {
  readonly keyId: string;
  readonly userId: string;
  readonly appId: string;
  /** SubjectPublicKeyInfo, DER, base64. */
  readonly publicKey: string;
  readonly registeredAt: string;
}

const KEY_ID_PATTERN = /^[0-9a-f]{64}$/;

export function mobileKeyParameterName(stackPrefix: string, keyId: string): string {
  return `/${stackPrefix}/platform/mobile-keys/${keyId}`;
}

function parseRecord(raw: string | undefined): MobileKeyRecord | null {
  if (!raw) return null;
  try {
    const r = JSON.parse(raw) as Partial<MobileKeyRecord>;
    if (
      typeof r.keyId !== "string" ||
      typeof r.userId !== "string" ||
      typeof r.appId !== "string" ||
      typeof r.publicKey !== "string" ||
      typeof r.registeredAt !== "string"
    ) {
      return null;
    }
    return r as MobileKeyRecord;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Google's attestation revocation list
// ---------------------------------------------------------------------------

const STATUS_URL = "https://android.googleapis.com/attestation/status";
/** One read per cold start, refreshed after this long in a warm container. */
const STATUS_TTL_MS = 6 * 60 * 60_000;
let statusCache: { serials: Set<string>; fetchedAt: number } | null = null;

/**
 * The serials Google lists as revoked or suspended. Throws when the list
 * cannot be read: a key that registers against an unknown revocation state
 * would stay registered after its certificate was revoked.
 */
export async function revokedSerials(
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<Set<string>> {
  if (statusCache && Date.now() - statusCache.fetchedAt < STATUS_TTL_MS) {
    return statusCache.serials;
  }
  const res = await fetchImpl(STATUS_URL);
  if (!res.ok) throw new Error(`the attestation revocation list answered ${res.status}`);
  const body = (await res.json()) as { entries?: Record<string, unknown> };
  const serials = new Set(Object.keys(body.entries ?? {}).map((s) => s.toLowerCase()));
  statusCache = { serials, fetchedAt: Date.now() };
  return serials;
}

/** Test seam. */
export function resetMobileKeyCaches(): void {
  statusCache = null;
  keyCache.clear();
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export interface RegistrationDeps {
  readonly ssm: SSMClient;
  readonly stackPrefix: string;
  /** Every app with a registered Android build. */
  loadIdentities(): Promise<MobileIdentity[]>;
  /** Pinned roots; Google's unless a test supplies its own. */
  readonly roots?: readonly string[];
  /** Revoked serials, lowercase hex. */
  revoked(): Promise<Set<string>>;
}

export type RegistrationResult =
  | { readonly ok: true; readonly keyId: string; readonly appId: string }
  | { readonly ok: false; readonly status: number; readonly message: string };

/**
 * Register a key for `userId`. `idToken` is the verified token the request
 * carried; `body` is the request body, `{ chain: string[] }` with each
 * certificate as base64 DER, leaf first.
 */
export async function registerMobileKey(
  userId: string,
  idToken: string,
  body: unknown,
  deps: RegistrationDeps,
): Promise<RegistrationResult> {
  const chainField = (body as { chain?: unknown } | null)?.chain;
  if (!Array.isArray(chainField) || chainField.some((c) => typeof c !== "string")) {
    return { ok: false, status: 400, message: "chain must be an array of base64 certificates" };
  }
  let revoked: Set<string>;
  try {
    revoked = await deps.revoked();
  } catch (err) {
    console.error("[mobile-keys] the revocation list is unreadable:", err);
    return { ok: false, status: 503, message: "Attestation cannot be checked right now" };
  }
  const challenge = createHash("sha256").update(idToken, "utf8").digest();
  const result = verifyAttestation(
    (chainField as string[]).map((c) => Buffer.from(c, "base64")),
    challenge,
    { roots: deps.roots ?? GOOGLE_ATTESTATION_ROOTS, isRevoked: (s) => revoked.has(s) },
  );
  if (!result.ok) return { ok: false, status: 403, message: result.reason };

  const appId = appForAttestedKey(result.key, await deps.loadIdentities());
  if (!appId) {
    console.warn(
      `[mobile-keys] no registered app matches ${result.key.packageName} ` +
        `(${result.key.signingCertDigests.join(",")})`,
    );
    return { ok: false, status: 403, message: "This app is not registered on this cloud" };
  }

  const record: MobileKeyRecord = {
    keyId: result.key.keyId,
    userId,
    appId,
    publicKey: result.key.publicKey,
    registeredAt: new Date().toISOString(),
  };
  const name = mobileKeyParameterName(deps.stackPrefix, record.keyId);
  try {
    await deps.ssm.send(
      new PutParameterCommand({
        Name: name,
        Type: "String",
        Value: JSON.stringify(record),
        Overwrite: false,
      }),
    );
  } catch (err) {
    if (!(err instanceof ParameterAlreadyExists)) throw err;
    // Registering the same key again is how an app recovers from a lost
    // answer. A key already held by another user or app is refused; the
    // challenge binding makes that unreachable for a real Keystore key.
    const existing = await loadMobileKey(record.keyId, deps);
    if (!existing || existing.userId !== userId || existing.appId !== appId) {
      return { ok: false, status: 409, message: "This key is registered to someone else" };
    }
  }
  console.log(
    JSON.stringify({ event: "mobile-key-registered", keyId: record.keyId, appId, userId }),
  );
  return { ok: true, keyId: record.keyId, appId };
}

// ---------------------------------------------------------------------------
// Lookup and request signatures
// ---------------------------------------------------------------------------

const KEY_CACHE_TTL_MS = 5 * 60_000;
const keyCache = new Map<string, { record: MobileKeyRecord; fetchedAt: number }>();

/** A registered key by id, or null. Cached briefly per warm container. */
export async function loadMobileKey(
  keyId: string,
  deps: Pick<RegistrationDeps, "ssm" | "stackPrefix">,
): Promise<MobileKeyRecord | null> {
  if (!KEY_ID_PATTERN.test(keyId)) return null;
  const cached = keyCache.get(keyId);
  if (cached && Date.now() - cached.fetchedAt < KEY_CACHE_TTL_MS) return cached.record;
  let record: MobileKeyRecord | null;
  try {
    const out = await deps.ssm.send(
      new GetParameterCommand({ Name: mobileKeyParameterName(deps.stackPrefix, keyId) }),
    );
    record = parseRecord(out.Parameter?.Value);
  } catch (err) {
    if (!(err instanceof ParameterNotFound)) throw err;
    record = null;
  }
  // Absence is not cached: a phone registers its key right after signing
  // in, possibly on another container, and must not be refused for minutes.
  if (record) keyCache.set(keyId, { record, fetchedAt: Date.now() });
  return record;
}

/** Whether `signature` is the key's signature over the request. */
export function verifyMobileSignature(
  record: MobileKeyRecord,
  args: {
    appId: string;
    method: string;
    subPath: string;
    timestampMs: number;
    body: Buffer;
    signature: string;
  },
): boolean {
  try {
    const message = mobileSignedMessage(
      args.appId,
      args.method,
      args.subPath,
      args.timestampMs,
      args.body,
    );
    return verify(
      "sha256",
      message,
      publicKeyFrom(record.publicKey),
      Buffer.from(args.signature, "base64"),
    );
  } catch {
    return false;
  }
}
