import { createHmac } from "node:crypto";
import type { AppCredentials } from "./credentials";

export type SignableBody = string | Buffer | Uint8Array | undefined;

// HMAC input is `appId:` bytes ++ raw body bytes. Operating on bytes (not
// `${appId}:${body}` as a string) keeps binary payloads lossless — the prior
// utf-8/Latin-1 detour silently round-tripped through string coercion and
// could disagree with the server on non-ASCII bytes.
function hmacInput(appId: string, body: SignableBody): Buffer {
  const prefix = Buffer.from(`${appId}:`, "utf8");
  if (body === undefined) return prefix;
  if (typeof body === "string") {
    return Buffer.concat([prefix as unknown as Uint8Array, Buffer.from(body, "utf8") as unknown as Uint8Array]);
  }
  const bodyBuf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return Buffer.concat([prefix as unknown as Uint8Array, bodyBuf as unknown as Uint8Array]);
}

export function signRequest(args: {
  appId: string;
  hmacSecret: string;
  body?: SignableBody;
}): Record<string, string> {
  const sig = createHmac("sha256", args.hmacSecret)
    .update(hmacInput(args.appId, args.body) as unknown as Uint8Array)
    .digest("hex");
  return {
    "X-Starkeep-App-Id": args.appId,
    "X-Starkeep-App-Sig": sig,
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
    ...signRequest({ appId: creds.appId, hmacSecret: creds.hmacSecret, body }),
  };
  return fetch(`${creds.dataServerUrl}${path}`, {
    method,
    headers,
    body: body as BodyInit | undefined,
  });
}
