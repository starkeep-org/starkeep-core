import { signRequest } from "./sign";
import type { AppCredentials } from "./credentials";

export interface ProxyRequest {
  method: string;
  /** Path under the data-server (without the proxy mount prefix), including query string. */
  path: string;
  headers: Record<string, string | undefined>;
  /** Pre-read raw body bytes (or undefined for GET/HEAD). */
  body?: Buffer | string;
}

export interface ProxyResponse {
  status: number;
  headers: Record<string, string>;
  body: ReadableStream<Uint8Array> | null;
}

const NO_BODY_METHODS = new Set(["GET", "HEAD"]);

/**
 * Framework-agnostic proxy. Given a normalized request, signs it with the
 * app's HMAC secret and forwards to the local-data-server. The caller adapts
 * its framework's request/response shape to {@link ProxyRequest} /
 * {@link ProxyResponse}. (See `nextProxyHandler` for the Next.js adapter.)
 */
export async function proxyToDataServer(
  creds: AppCredentials,
  req: ProxyRequest,
): Promise<ProxyResponse> {
  const target = `${creds.dataServerUrl}${req.path.startsWith("/") ? "" : "/"}${req.path}`;
  const body = NO_BODY_METHODS.has(req.method.toUpperCase()) ? undefined : req.body;

  const fwdHeaders: Record<string, string> = signRequest({
    appId: creds.appId,
    hmacSecret: creds.hmacSecret,
    method: req.method,
    path: req.path,
    body,
  });
  const ct = req.headers["content-type"];
  if (ct) fwdHeaders["Content-Type"] = ct;

  const upstream = await fetch(target, {
    method: req.method,
    headers: fwdHeaders,
    body: body as BodyInit | undefined,
  });

  const respHeaders: Record<string, string> = {};
  upstream.headers.forEach((value, key) => {
    if (key.toLowerCase() === "content-length") return;
    respHeaders[key] = value;
  });
  return {
    status: upstream.status,
    headers: respHeaders,
    body: upstream.body,
  };
}
