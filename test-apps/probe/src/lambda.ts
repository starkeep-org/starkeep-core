/**
 * API Gateway v2 (payload format 2.0) ↔ web `Request`/`Response`.
 *
 * The platform gives an app a bare Lambda and lets it choose its own framework;
 * Probe's choice is no framework, so this is the whole adapter. Kept separate
 * from `app.ts` so the app's behavior is testable without an event shape.
 */

export interface ApiGatewayV2Event {
  rawPath?: string;
  rawQueryString?: string;
  headers?: Record<string, string | undefined>;
  cookies?: string[];
  body?: string;
  isBase64Encoded?: boolean;
  requestContext?: { http?: { method?: string } };
}

export interface ApiGatewayV2Result {
  statusCode: number;
  headers: Record<string, string>;
  cookies?: string[];
  body: string;
  isBase64Encoded?: boolean;
}

/** Build a web Request from the event, preserving the body and the cookie jar. */
export function toRequest(event: ApiGatewayV2Event): Request {
  const method = event.requestContext?.http?.method ?? "GET";
  const headers = new Headers();
  for (const [k, v] of Object.entries(event.headers ?? {})) {
    if (v !== undefined) headers.set(k, v);
  }
  // API Gateway v2 lifts cookies out of the headers into their own array; the
  // session library reads the `Cookie` header, so put them back.
  if (event.cookies?.length) headers.set("cookie", event.cookies.join("; "));

  const host = headers.get("host") ?? "probe.invalid";
  const query = event.rawQueryString ? `?${event.rawQueryString}` : "";
  const url = `https://${host}${event.rawPath ?? "/"}${query}`;

  const hasBody = event.body !== undefined && method !== "GET" && method !== "HEAD";
  const body = hasBody
    ? event.isBase64Encoded
      ? Buffer.from(event.body!, "base64")
      : Buffer.from(event.body!, "utf8")
    : undefined;

  return new Request(url, { method, headers, ...(body ? { body } : {}) });
}

/**
 * Serialize a web Response into the event result.
 *
 * `Set-Cookie` moves to the `cookies` array: a plain headers map holds one
 * value per name, so a sign-in setting both session and token cookies would
 * lose one of them.
 */
export async function toResult(res: Response): Promise<ApiGatewayV2Result> {
  const headers: Record<string, string> = {};
  const cookies: string[] = [];
  res.headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") return;
    headers[key] = value;
  });
  for (const c of res.headers.getSetCookie()) cookies.push(c);

  const buf = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get("content-type") ?? "";
  const isText = /^text\/|json|javascript|xml/i.test(contentType);
  return {
    statusCode: res.status,
    headers,
    ...(cookies.length ? { cookies } : {}),
    body: isText ? buf.toString("utf8") : buf.toString("base64"),
    ...(isText ? {} : { isBase64Encoded: true }),
  };
}
