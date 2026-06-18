import { createHmac } from "node:crypto";
import type { AppCredentials } from "./credentials";

export type SignableBody = string | Buffer | Uint8Array | undefined;

// Header names the signature scheme emits/consumes. Kept here as the single
// source of truth; the cloud verifier (a separately-deployed artifact that
// cannot import this package) mirrors these literals by hand.
export const APP_ID_HEADER = "X-Starkeep-App-Id";
export const APP_SIG_HEADER = "X-Starkeep-App-Sig";
export const APP_TS_HEADER = "X-Starkeep-App-Ts";

// Freshness window for the signed timestamp. A signature whose X-Starkeep-App-Ts
// is more than this far from the verifier's clock (in either direction, to
// tolerate skew) is rejected. Bounds the replay window to ~5 min.
export const APP_SIG_MAX_SKEW_MS = 5 * 60_000;

/**
 * Canonical request path used in the signed message: pathname only (query
 * string stripped) and percent-decoded, so client and server agree regardless
 * of how the path was encoded on the wire. API Gateway normalizes %2F back to
 * "/" before the cloud handler routes, and the local-data-server routes on
 * `URL.pathname` (already decoded) — decoding here makes both line up with the
 * logical path the caller passed.
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

// HMAC input is `${appId}:${METHOD}:${path}:${ts}:` bytes ++ raw body bytes.
// Binding method + path stops a signature captured for one POST from being
// replayed against a different endpoint; binding the timestamp (enforced
// against a freshness window on the verifier) stops indefinite replay. Operating
// on bytes (not a fully-stringified message) keeps binary payloads lossless.
function hmacInput(
  appId: string,
  method: string,
  path: string,
  ts: number,
  body: SignableBody,
): Buffer {
  const prefix = Buffer.from(
    `${appId}:${method.toUpperCase()}:${canonicalSignedPath(path)}:${ts}:`,
    "utf8",
  );
  if (body === undefined) return prefix;
  const bodyBuf =
    typeof body === "string"
      ? Buffer.from(body, "utf8")
      : Buffer.isBuffer(body)
        ? body
        : Buffer.from(body);
  return Buffer.concat([prefix as unknown as Uint8Array, bodyBuf as unknown as Uint8Array]);
}

export function signRequest(args: {
  appId: string;
  hmacSecret: string;
  method: string;
  path: string;
  body?: SignableBody;
  /** ms epoch; defaults to Date.now(). Exposed for deterministic tests. */
  timestamp?: number;
}): Record<string, string> {
  const ts = args.timestamp ?? Date.now();
  const sig = createHmac("sha256", args.hmacSecret)
    .update(hmacInput(args.appId, args.method, args.path, ts, args.body) as unknown as Uint8Array)
    .digest("hex");
  return {
    [APP_ID_HEADER]: args.appId,
    [APP_SIG_HEADER]: sig,
    [APP_TS_HEADER]: String(ts),
  };
}

// Methods without a body sign over an empty body — must match the server's
// `validateAppHmac` (which signs the empty string for GET/HEAD).
const NO_BODY_METHODS = new Set(["GET", "HEAD"]);

export interface SignedFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: SignableBody;
}

export async function signedFetch(
  creds: AppCredentials,
  path: string,
  init?: SignedFetchInit,
): Promise<Response> {
  const method = init?.method ?? "GET";
  const body = NO_BODY_METHODS.has(method.toUpperCase()) ? undefined : init?.body;
  const headers: Record<string, string> = {
    ...(init?.headers ?? {}),
    ...signRequest({
      appId: creds.appId,
      hmacSecret: creds.hmacSecret,
      method,
      path,
      body,
    }),
  };
  return fetch(`${creds.dataServerUrl}${path}`, {
    method,
    headers,
    body: body as BodyInit | undefined,
  });
}
