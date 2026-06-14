import { loadAppCredentials } from "./credentials";
import { proxyToDataServer } from "./proxy";

// Narrow shape of NextRequest we depend on — avoids taking a `next` peer
// dependency just to type the param.
interface MinimalNextRequest {
  method: string;
  url: string;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface NextProxyParams { path?: string[] }

export interface NextProxyOptions {
  /** App id whose credentials to load. */
  appId: string;
  /**
   * Override response on missing credentials. Defaults to a 503 JSON body
   * pointing at the admin-web install flow.
   */
  onMissingCredentials?: () => Response;
}

/**
 * Returns a handler usable as the body of a Next.js route segment for every
 * verb (GET/POST/PUT/PATCH/DELETE). Forwards to the local-data-server with the
 * app's HMAC signature. Browser-driven apps mount this at
 * `app/api/local-data/[...path]/route.ts` so the HMAC secret stays
 * server-side.
 */
export function createNextProxyHandler(opts: NextProxyOptions) {
  return async function handler(
    req: MinimalNextRequest,
    ctx: { params: Promise<NextProxyParams> },
  ): Promise<Response> {
    const creds = await loadAppCredentials(opts.appId);
    if (!creds) {
      if (opts.onMissingCredentials) return opts.onMissingCredentials();
      return new Response(
        JSON.stringify({
          error: `${opts.appId} has not been installed locally — run install from admin-web first`,
        }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      );
    }

    const params = await ctx.params;
    const segments = params.path ?? [];
    const url = new URL(req.url);
    const path = `/${segments.join("/")}${url.search}`;

    const method = req.method.toUpperCase();
    const body =
      method === "GET" || method === "HEAD"
        ? undefined
        : await readBody(req);

    const headersRecord: Record<string, string> = {};
    const ct = req.headers.get("content-type");
    if (ct) headersRecord["content-type"] = ct;

    const upstream = await proxyToDataServer(creds, {
      method,
      path,
      headers: headersRecord,
      body,
    });

    return new Response(upstream.body, {
      status: upstream.status,
      headers: new Headers(upstream.headers),
    });
  };
}

async function readBody(req: MinimalNextRequest): Promise<Buffer | string> {
  const ct = req.headers.get("content-type") ?? "";
  // Text-shaped content types stay as strings so the upstream Content-Length
  // and signature both line up with what fetch will send on the wire.
  if (
    ct.startsWith("application/json") ||
    ct.startsWith("text/") ||
    ct.startsWith("application/x-www-form-urlencoded")
  ) {
    return await req.text();
  }
  const ab = await req.arrayBuffer();
  return Buffer.from(ab);
}
