/**
 * Delegation tokens: platform-signed JWTs that name one delegation row.
 *
 * A token is `skd_` followed by a compact JWT signed with ES256. The
 * deployment's delegation key signs it; the broker reads the private key from
 * an SSM SecureString, and the gateway's delegated authorizer holds only the
 * public key. The token carries the user, the app, the delegation id, the
 * mode and the channel, so the authorizer can decide without a database. The
 * broker still looks the row up on every data call, which is what makes
 * revocation immediate at the data plane.
 *
 * The same private key also seeds the key that encrypts each delegation's
 * stored Cognito refresh token, through HKDF, so the deployment holds one
 * secret for both jobs.
 *
 * Every verification failure returns null rather than throwing: on the auth
 * path a thrown error becomes a 500, which reads as an outage where a refusal
 * is what happened.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  hkdfSync,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
  type KeyObject,
} from "node:crypto";
import {
  DELEGATION_MODES,
  DELEGATION_TOKEN_PREFIX,
  type DelegationChannel,
  type DelegationClaims,
  type DelegationMode,
} from "@starkeep/protocol-primitives";

export interface DelegationPublicKey {
  readonly publicKey: KeyObject;
  /** A short fingerprint of the public key, named in each token's header. */
  readonly kid: string;
}

export interface DelegationSigningKey extends DelegationPublicKey {
  readonly privateKey: KeyObject;
  /** Encrypts and decrypts stored Cognito refresh tokens. */
  readonly refreshKey: Buffer;
}

function kidFor(publicKey: KeyObject): string {
  const der = publicKey.export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("base64url").slice(0, 16);
}

/** The public half, from the PEM the authorizer receives in its environment. */
export function delegationPublicKeyFromPem(pem: string): DelegationPublicKey {
  const publicKey = createPublicKey(pem);
  return { publicKey, kid: kidFor(publicKey) };
}

/** Both halves and the derived refresh-token key, from the stored private key. */
export function delegationSigningKeyFromPem(pem: string): DelegationSigningKey {
  const privateKey = createPrivateKey(pem);
  const publicKey = createPublicKey(privateKey);
  const der = privateKey.export({ type: "pkcs8", format: "der" });
  const refreshKey = Buffer.from(
    hkdfSync("sha256", der, Buffer.alloc(0), "starkeep-delegation-refresh-token", 32),
  );
  return { privateKey, publicKey, kid: kidFor(publicKey), refreshKey };
}

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export interface NewDelegationToken {
  userId: string;
  appId: string;
  delegationId: string;
  mode: DelegationMode;
  channel: DelegationChannel;
  /** Milliseconds since the epoch. */
  expiresAtMs: number;
  nowMs?: number;
}

/** Issue a token for one delegation. */
export function signDelegationToken(key: DelegationSigningKey, t: NewDelegationToken): string {
  const iat = Math.floor((t.nowMs ?? Date.now()) / 1000);
  const claims: DelegationClaims = {
    sub: t.userId,
    aud: t.appId,
    sk_dlg: t.delegationId,
    sk_mode: t.mode,
    sk_channel: t.channel,
    exp: Math.floor(t.expiresAtMs / 1000),
    iat,
  };
  const signingInput = `${b64url({ alg: "ES256", typ: "JWT", kid: key.kid })}.${b64url(claims)}`;
  const signature = sign("sha256", Buffer.from(signingInput), {
    key: key.privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${DELEGATION_TOKEN_PREFIX}${signingInput}.${signature.toString("base64url")}`;
}

function decodeJson(segment: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The claims of a token this deployment signed and that has not expired, or
 * null. The caller checks `aud` against the app the request names.
 */
export function verifyDelegationToken(
  token: string,
  key: DelegationPublicKey,
  nowMs: number = Date.now(),
): DelegationClaims | null {
  try {
    if (!token.startsWith(DELEGATION_TOKEN_PREFIX)) return null;
    const parts = token.slice(DELEGATION_TOKEN_PREFIX.length).split(".");
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, sigB64] = parts as [string, string, string];
    const header = decodeJson(headerB64);
    if (!header || header.alg !== "ES256" || header.kid !== key.kid) return null;
    const ok = verify(
      "sha256",
      Buffer.from(`${headerB64}.${payloadB64}`),
      { key: key.publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(sigB64, "base64url"),
    );
    if (!ok) return null;

    // Claims are believed only after the signature checks out.
    const p = decodeJson(payloadB64);
    if (!p) return null;
    const { sub, aud, sk_dlg, sk_mode, sk_channel, exp, iat } = p;
    if (typeof sub !== "string" || !sub) return null;
    if (typeof aud !== "string" || !aud) return null;
    if (typeof sk_dlg !== "string" || !sk_dlg) return null;
    if (!DELEGATION_MODES.includes(sk_mode as DelegationMode)) return null;
    if (sk_channel !== "app" && sk_channel !== "platform") return null;
    if (typeof exp !== "number" || exp * 1000 <= nowMs) return null;
    if (typeof iat !== "number") return null;
    return {
      sub,
      aud,
      sk_dlg,
      sk_mode: sk_mode as DelegationMode,
      sk_channel,
      exp,
      iat,
    };
  } catch {
    return null;
  }
}

/** The public key as a JWKS document, for `GET /connect/jwks.json`. */
export function delegationJwks(key: DelegationPublicKey): { keys: Record<string, unknown>[] } {
  const jwk = key.publicKey.export({ format: "jwk" });
  return { keys: [{ ...jwk, kid: key.kid, alg: "ES256", use: "sig" }] };
}

const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Encrypt a Cognito refresh token for storage. AES-256-GCM with the
 * delegation id as associated data, so a ciphertext copied onto another row
 * does not decrypt there.
 */
export function sealRefreshToken(key: Buffer, delegationId: string, token: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(delegationId));
  const body = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

/** Decrypt a stored refresh token, or null when the ciphertext does not check out. */
export function openRefreshToken(key: Buffer, delegationId: string, sealed: string): string | null {
  try {
    const raw = Buffer.from(sealed, "base64url");
    if (raw.length <= IV_BYTES + TAG_BYTES) return null;
    const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, IV_BYTES));
    decipher.setAAD(Buffer.from(delegationId));
    decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([
      decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}

/** Compare two secrets without leaking where they differ. */
export function secretsEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
