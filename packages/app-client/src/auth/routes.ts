/**
 * The session endpoints an app mounts to get refresh, sign-out, a signed-in
 * probe and a bearer token. The app supplies the *page*; the platform supplies
 * these, because cookie names, flags and path scoping are platform concerns and
 * an app that reimplements them can only get them wrong.
 *
 * Sign-in is not here. A person signs in on the managed login page, which the
 * platform's `/auth/start` route sends the browser to, and the platform's
 * `/auth/callback` sets the cookies. App code never receives a password: a
 * cloud app is untrusted code, and a password it held would sign in to every
 * other app and, for an admin, to the deployment itself.
 */
import type { MinimalRequest } from "../data-proxy.js";
import {
  SESSION_COOKIE,
  clearCookies,
  cookiePath,
  mintIdToken,
  poolConfig,
  readCookie,
  signOutAddress,
  tokenCookie,
} from "./session.js";
import { refreshTokens } from "./cognito.js";
import { verifyIdToken } from "./verify.js";

export interface SessionRouteOptions {
  appId: string;
}

type RouteContext = { params: Promise<{ action?: string[] }> };

function json(body: unknown, status = 200, cookies: string[] = []): Response {
  const headers = new Headers({ "Content-Type": "application/json" });
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * Refuse a state-changing request that a third-party page initiated. The
 * cookies are `SameSite=Lax`, so a cross-site POST does not carry them in the
 * first place; this closes the same door from the other side and costs
 * nothing. A missing `Origin` is allowed — non-browser callers (curl, the e2e
 * suite) send none, and they are not the CSRF threat.
 */
function crossOrigin(req: MinimalRequest): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  let sent: string;
  try {
    sent = new URL(origin).origin;
  } catch {
    return true;
  }
  try {
    if (sent === new URL(req.url).origin) return false;
  } catch {
    return true;
  }

  // Behind the platform's CloudFront distribution, the request the Lambda sees
  // is not the request the browser made: CloudFront forwards every viewer
  // header except Host, so `Origin` names the domain the person is on while
  // `req.url` names the origin server. Comparing only those two refuses every
  // real browser sign-in and lets curl through — the exact inverse of what a
  // CSRF check is for, and invisible to any caller that sends no Origin.
  //
  // STARKEEP_API_GATEWAY_URL is the browser-facing base the platform injects at
  // install time (the distribution, falling back to the raw gateway). It is the
  // one value that knows what "same origin" means for this deployment; the app
  // cannot infer it from the request.
  const publicBase = process.env.STARKEEP_API_GATEWAY_URL;
  if (publicBase) {
    try {
      if (sent === new URL(publicBase).origin) return false;
    } catch {
      // A malformed configured base grants no exemption.
    }
  }
  return true;
}

export function createSessionRoutes(opts: SessionRouteOptions): {
  POST: (req: MinimalRequest, ctx: RouteContext) => Promise<Response>;
  GET: (req: MinimalRequest, ctx: RouteContext) => Promise<Response>;
} {
  const { appId } = opts;

  /**
   * The gateway authorizer cannot set cookies, so an expired `sk_token` gets a
   * bare 401 with no way to recover in-band. This route is the recovery: it is
   * left public at the gateway and authenticates on `sk_session` in app code.
   */
  async function refresh(req: MinimalRequest): Promise<Response> {
    const cfg = poolConfig();
    if (!cfg) return json({ error: "This deployment has no user pool configured" }, 503);

    const refreshToken = readCookie(req, SESSION_COOKIE);
    if (!refreshToken) return json({ error: "Not authenticated" }, 401);

    let minted;
    try {
      minted = await refreshTokens(cfg, refreshToken);
    } catch {
      // The refresh token is spent. Clear both cookies so the browser stops
      // presenting a credential that will keep failing.
      return json({ error: "Session expired" }, 401, clearCookies(appId));
    }
    const claims = await verifyIdToken(minted.idToken, cfg);
    if (!claims) return json({ error: "Session expired" }, 401, clearCookies(appId));

    return json({ signedIn: true, email: claims.email }, 200, [
      tokenCookie(appId, minted.idToken, minted.expiresIn),
    ]);
  }

  /**
   * Clears the browser's copy, and names the platform's sign-out page for the
   * page to visit next. That page ends the managed login session too; without
   * it the next "Sign in" would skip the password. Neither revokes the refresh
   * token — AdminUserGlobalSignOut is the tool for that, and it is an operator
   * action rather than something a page should be able to trigger.
   */
  function signOut(): Response {
    return json({ signedIn: false, signOutUrl: signOutAddress(appId) }, 200, clearCookies(appId));
  }

  async function probe(req: MinimalRequest): Promise<Response> {
    const minted = await mintIdToken(req, appId);
    if (!minted) return json({ signedIn: false });
    return json(
      { signedIn: true, email: minted.claims.email },
      200,
      minted.setCookie ? [minted.setCookie] : [],
    );
  }

  /**
   * An access token for the one call a cookie cannot serve: Photos posts to
   * `/api/resize` directly on the gateway, where the route is JWT-gated and
   * the browser must present a bearer token. What this hands out is good for
   * an hour; the refresh token stays server-side.
   */
  async function token(req: MinimalRequest): Promise<Response> {
    const minted = await mintIdToken(req, appId);
    if (!minted) return json({ error: "Not authenticated" }, 401);
    const remaining = Math.max(0, minted.claims.exp - Math.floor(Date.now() / 1000));
    return json(
      { accessToken: minted.token, expiresIn: remaining },
      200,
      minted.setCookie ? [minted.setCookie] : [],
    );
  }

  async function action(ctx: RouteContext): Promise<string> {
    return ((await ctx.params).action ?? []).join("/");
  }

  return {
    async POST(req, ctx) {
      if (crossOrigin(req)) return json({ error: "Cross-origin request refused" }, 403);
      switch (await action(ctx)) {
        case "refresh":
          return refresh(req);
        case "sign-out":
          return signOut();
        default:
          return json({ error: "Unknown session action" }, 404);
      }
    },
    async GET(req, ctx) {
      switch (await action(ctx)) {
        case "":
          return probe(req);
        case "token":
          return token(req);
        default:
          return json({ error: "Unknown session action" }, 404);
      }
    },
  };
}

export { cookiePath };
