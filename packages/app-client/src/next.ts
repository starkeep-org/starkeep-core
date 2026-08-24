import { loadAppCredentials } from "./credentials";
import { proxyToDataServer } from "./proxy";

// Narrow shape of NextRequest we depend on — avoids taking a `next` peer
// dependency just to type the param.
export interface MinimalNextRequest {
  method: string;
  url: string;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface NextProxyParams { path?: string[] }

/**
 * Whether a valid end user must be present before this proxy will sign
 * anything, expressed as a decision the caller cannot skip.
 *
 * This is plan §3's `requireUser`, promoted from an optional flag to a
 * required field. The promotion is the whole point: an optional security flag
 * is a flag that stays unset in every app written before the flag existed,
 * which was every app we had. A required union makes the next app's author
 * answer the question at scaffold time, and cannot be answered by copying an
 * app that never faced it.
 *
 * The platform will not answer it for them. The cloud data plane authenticates
 * the *app* (an HMAC signature identifies which app is calling, not which
 * person), and the gateway's JWT authorizer cannot sit in front of a browser
 * navigation. End-user identity is therefore the app's business — and this
 * type is where the app says whether it has taken that business up.
 */
export type ProxyEndUserAuth =
  | {
      auth: "session";
      /**
       * Resolve the caller's session, typically from an HttpOnly cookie. A
       * falsy result means no valid end user and the proxy answers 401
       * without ever loading the app's HMAC credential.
       */
      verifySession: (req: MinimalNextRequest) => boolean | Promise<boolean>;
      /**
       * Skip the check in local mode, where the browser, the data, and the
       * person are all on one machine and there is no second party to
       * authenticate against. Defaults to true, because gating on-device data
       * behind a sign-in would break the local-first guarantee. Set false for
       * an app that wants the check on both surfaces.
       */
      allowAnonymousLocal?: boolean;
    }
  | {
      auth: "anonymous";
      /**
       * Why this proxy signs for callers it has not authenticated. Required,
       * and expected to be a sentence a reviewer can disagree with — "the data
       * behind this proxy is public", or a pointer to the work that will
       * close it. An unjustifiable value here is the signal that the answer
       * should have been "session".
       */
      justification: string;
    };

export interface NextProxyOptions {
  /** App id whose credentials to load. */
  appId: string;
  /**
   * Required. See {@link ProxyEndUserAuth} — the proxy holds the app's HMAC
   * credential and will sign whatever reaches it, so it refuses to be
   * constructed without an explicit statement of who is allowed to reach it.
   */
  endUserAuth: ProxyEndUserAuth;
  /**
   * Override response on missing credentials. Defaults to a 503 JSON body
   * pointing at the admin-web install flow.
   */
  onMissingCredentials?: () => Response;
  /**
   * Override the response given to a caller with no valid session. Defaults
   * to a bare 401 JSON body.
   */
  onUnauthenticated?: () => Response;
}

function isCloudMode(): boolean {
  return process.env.STARKEEP_APP_CLIENT_MODE === "cloud";
}

/**
 * Returns a handler usable as the body of a Next.js route segment for every
 * verb (GET/POST/PUT/PATCH/DELETE). Forwards to the configured data server
 * with the app's HMAC signature. Browser-driven apps mount this under
 * `app/api/.../[...path]/route.ts` so the HMAC secret stays server-side.
 *
 * The same mount serves both surfaces: in local mode it forwards to the
 * loopback local-data-server, in cloud mode to the shared API Gateway. That
 * is why `endUserAuth` is not optional — on the loopback surface there is no
 * one else to authenticate, and on the cloud surface there is nothing else
 * doing it.
 */
export function createNextProxyHandler(opts: NextProxyOptions) {
  return async function handler(
    req: MinimalNextRequest,
    ctx: { params: Promise<NextProxyParams> },
  ): Promise<Response> {
    // Before anything else, and specifically before the credential load: a
    // request that fails the end-user check must never cause the app's HMAC
    // secret to be read, let alone used to sign an upstream call.
    if (opts.endUserAuth.auth === "session") {
      const exemptLocal = opts.endUserAuth.allowAnonymousLocal ?? true;
      if (isCloudMode() || !exemptLocal) {
        if (!(await opts.endUserAuth.verifySession(req))) {
          if (opts.onUnauthenticated) return opts.onUnauthenticated();
          return new Response(JSON.stringify({ error: "Not authenticated" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }
      }
    }

    // Having established there is a person here, carry the proof of it
    // upstream. The cloud data plane requires a credential bound to a named
    // end user on every call, and this proxy is the app's compute acting for
    // that user — so it presents the token the platform minted for them
    // alongside the signature that says which app is asking.
    //
    // `mintIdToken` rather than a bare cookie read: the token is good for about
    // an hour and the session outlives it, so a request arriving with a
    // near-expired one is served with a fresh token and the browser is told to
    // keep it. A cookie read alone would forward a token the broker is about to
    // start refusing, and the failure would arrive an hour into a session with
    // nothing in the request to explain it.
    let userToken: string | undefined;
    let refreshedTokenCookie: string | undefined;
    if (isCloudMode()) {
      const { mintIdToken } = await import("./auth/session.js");
      const minted = await mintIdToken(req, opts.appId);
      if (minted) {
        userToken = minted.token;
        refreshedTokenCookie = minted.setCookie;
      }
    }

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
      userToken,
    });

    const responseHeaders = new Headers(upstream.headers);
    if (refreshedTokenCookie) responseHeaders.append("Set-Cookie", refreshedTokenCookie);
    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
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

/**
 * The documented answer to {@link ProxyEndUserAuth} for a cloud app: wire in
 * the package's own cookie-session verifier.
 *
 * An app should not be assembling this itself. The explicit
 * `{ auth: "session", verifySession }` form stays for an unusual verifier, but
 * "unusual" is the operative word — every app in this codebase wants exactly
 * what this returns.
 */
export function sessionAuth(opts?: { allowAnonymousLocal?: boolean }): ProxyEndUserAuth {
  return {
    auth: "session",
    // Imported lazily so a local-only app that never calls this does not pull
    // the verifier — and its `fetch`-to-Cognito path — into its bundle.
    verifySession: async (req) => {
      const { requireSession } = await import("./auth/session.js");
      return (await requireSession(req)) !== null;
    },
    ...(opts?.allowAnonymousLocal === undefined
      ? {}
      : { allowAnonymousLocal: opts.allowAnonymousLocal }),
  };
}
