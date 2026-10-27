/**
 * How a mobile app signs a data-plane request with its attested key.
 *
 * A mobile app's token comes from a public Cognito client, so the token alone
 * cannot say which app sent it. Each request therefore also carries a
 * signature by a key the app registered with an Android Key Attestation (see
 * the broker's `mobile-attestation.ts`). The cloud resolves the app from the
 * key, never from a header, and applies that app's manifest grants.
 *
 * The signed message is the one the app HMAC signs:
 *
 *     `${appId}:${METHOD}:${path}:${ts}:` followed by the raw body
 *
 * where `appId` is the channel the URL names, `path` is the decoded pathname
 * below `/apps/<appId>`, `ts` is the `X-Starkeep-App-Ts` value in epoch
 * milliseconds, and GET and HEAD sign an empty body. The signature is
 * ECDSA P-256 over SHA-256 of that message, DER-encoded, base64. A phone can
 * hash the message itself and have the Keystore sign the digest, so a
 * megabyte body never crosses into the signing call.
 */

/** The attested key's id: SHA-256 of its SubjectPublicKeyInfo, hex. */
export const MOBILE_KEY_ID_HEADER = "X-Starkeep-Key-Id";
/** The request's signature by the attested key, DER, base64. */
export const MOBILE_KEY_SIG_HEADER = "X-Starkeep-Key-Sig";
/** The signing time, epoch milliseconds. The same header the app HMAC uses. */
export const MOBILE_TS_HEADER = "X-Starkeep-App-Ts";

/** The path a signature covers: the pathname alone, percent-decoded. */
export function canonicalSignedPath(path: string): string {
  const q = path.indexOf("?");
  const pathname = q >= 0 ? path.slice(0, q) : path;
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

/**
 * The bytes a mobile request signs, for a body given as bytes. `subPath` is
 * the path below `/apps/<appId>`, such as `/sync/exchange`.
 */
export function mobileSignedMessage(
  appId: string,
  method: string,
  subPath: string,
  timestampMs: number,
  body: Uint8Array,
): Uint8Array {
  const upper = method.toUpperCase();
  const prefix = new TextEncoder().encode(
    `${appId}:${upper}:${canonicalSignedPath(subPath)}:${timestampMs}:`,
  );
  const signed = upper === "GET" || upper === "HEAD" ? new Uint8Array(0) : body;
  const out = new Uint8Array(prefix.length + signed.length);
  out.set(prefix, 0);
  out.set(signed, prefix.length);
  return out;
}

/** What signs a mobile request: the attested key's id, and its signature over a message. */
export interface MobileRequestSigner {
  /** The registered key's id, or null when this phone has none yet. */
  keyId(): Promise<string | null>;
  /** The DER signature, base64, over SHA-256 of `message`. */
  sign(message: Uint8Array): Promise<string>;
  readonly now?: () => number;
}

/** Thrown for a data-plane request when the phone has no registered key. */
export class NoAttestedKeyError extends Error {
  constructor() {
    super("This phone has no attested key; sign in again to sync");
    this.name = "NoAttestedKeyError";
  }
}

async function bodyBytes(input: RequestInfo | URL, init: RequestInit | undefined): Promise<Uint8Array> {
  const body = init?.body ?? (input instanceof Request ? await input.clone().arrayBuffer() : null);
  if (body === null || body === undefined) return new Uint8Array(0);
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  // A stream or form body cannot be signed without consuming it. The data
  // plane sends neither; refusing beats signing something other than what goes.
  throw new Error("A mobile request body must be a string or bytes to be signed");
}

/**
 * Wrap a channel's `fetch` so every request to the data plane carries the
 * attested key's signature.
 *
 * `channelUrl` is the channel's base, `<cloud>/apps/<appId>`. Only URLs under
 * it are signed: the same `fetch` downloads from presigned S3 and CloudFront
 * URLs, and the key's signature has no business in a request to either. Apply
 * it inside {@link withUserToken}'s wrapper or outside it; the two touch
 * different headers.
 */
export function withMobileKeySignature(
  fetchImpl: typeof globalThis.fetch,
  channelUrl: string,
  signer: MobileRequestSigner,
): typeof globalThis.fetch {
  const base = channelUrl.replace(/\/+$/, "");
  const appId = decodeURIComponent(base.slice(base.lastIndexOf("/") + 1));
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(`${base}/`)) return fetchImpl(input, init);
    const keyId = await signer.keyId();
    if (!keyId) throw new NoAttestedKeyError();
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    // By slicing rather than `new URL(...).pathname`, which React Native's
    // URL does not implement on every version the phone runs.
    const subPath = url.slice(base.length).split(/[?#]/, 1)[0] || "/";
    const ts = (signer.now ?? Date.now)();
    const signature = await signer.sign(
      mobileSignedMessage(appId, method, subPath, ts, await bodyBytes(input, init)),
    );
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
    headers.set(MOBILE_KEY_ID_HEADER, keyId);
    headers.set(MOBILE_KEY_SIG_HEADER, signature);
    headers.set(MOBILE_TS_HEADER, String(ts));
    return fetchImpl(input, { ...init, headers });
  };
}
