/**
 * The session endpoints an app mounts to get sign-in, refresh, sign-out and a
 * signed-in probe. The app supplies the *page*; the platform supplies these,
 * because cookie names, flags, path scoping and the Cognito flow are all
 * platform concerns and an app that reimplements them can only get them wrong.
 */
import type { MinimalNextRequest } from "../next.js";
import { CognitoError, initiateAuth, respondNewPassword } from "./cognito.js";
import {
  SESSION_COOKIE,
  clearCookies,
  cookiePath,
  mintIdToken,
  poolConfig,
  readCookie,
  sessionCookie,
  tokenCookie,
} from "./session.js";
import { refreshTokens } from "./cognito.js";
import { verifyIdToken } from "./verify.js";

// Cognito's default refresh-token validity is 30 days. The cookie outliving
// the token would leave a browser presenting a credential Cognito has already
// stopped honouring, which reads to the user as a broken app rather than a
// finished session; the reverse just asks them to sign in again.
const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60;

export interface SessionRouteOptions {
  appId: string;
  /** Overrides the 30-day default; the deployment's own Cognito setting wins. */
  sessionMaxAgeSeconds?: number;
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
function crossOrigin(req: MinimalNextRequest): boolean {
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

async function readJsonBody(req: MinimalNextRequest): Promise<Record<string, unknown>> {
  try {
    const text = await req.text();
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function cognitoFailure(err: unknown): Response {
  if (err instanceof CognitoError) {
    // Cognito's own 4xx are the user's problem (bad password, unknown user);
    // anything else is ours, and must not be reported as a rejected sign-in.
    const status = err.status >= 400 && err.status < 500 ? 401 : 502;
    return json({ error: err.message, code: err.code }, status);
  }
  return json({ error: "Sign-in failed" }, 502);
}

export function createSessionRoutes(opts: SessionRouteOptions): {
  POST: (req: MinimalNextRequest, ctx: RouteContext) => Promise<Response>;
  GET: (req: MinimalNextRequest, ctx: RouteContext) => Promise<Response>;
} {
  const { appId } = opts;
  const maxAge = opts.sessionMaxAgeSeconds ?? SESSION_MAX_AGE_S;

  async function signIn(req: MinimalNextRequest): Promise<Response> {
    const cfg = poolConfig();
    if (!cfg) return json({ error: "This deployment has no user pool configured" }, 503);

    const body = await readJsonBody(req);
    const email = typeof body.email === "string" ? body.email : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!email || !password) return json({ error: "email and password are required" }, 400);

    let result;
    try {
      result = await initiateAuth(cfg, email, password);
    } catch (err) {
      return cognitoFailure(err);
    }

    if ("challenge" in result) {
      // No cookies: the user is not signed in until the challenge is answered.
      return json({ challenge: result.challenge, session: result.session });
    }
    return json({ signedIn: true, email }, 200, [
      sessionCookie(appId, result.tokens.refreshToken, maxAge),
      tokenCookie(appId, result.tokens.idToken, result.tokens.expiresIn),
    ]);
  }

  async function newPassword(req: MinimalNextRequest): Promise<Response> {
    const cfg = poolConfig();
    if (!cfg) return json({ error: "This deployment has no user pool configured" }, 503);

    const body = await readJsonBody(req);
    const session = typeof body.session === "string" ? body.session : "";
    const email = typeof body.email === "string" ? body.email : "";
    const pw = typeof body.newPassword === "string" ? body.newPassword : "";
    if (!session || !email || !pw) {
      return json({ error: "session, email and newPassword are required" }, 400);
    }

    let tokens;
    try {
      tokens = await respondNewPassword(cfg, session, email, pw);
    } catch (err) {
      return cognitoFailure(err);
    }
    return json({ signedIn: true, email }, 200, [
      sessionCookie(appId, tokens.refreshToken, maxAge),
      tokenCookie(appId, tokens.idToken, tokens.expiresIn),
    ]);
  }

  /**
   * The gateway authorizer cannot set cookies, so an expired `sk_token` gets a
   * bare 401 with no way to recover in-band. This route is the recovery: it is
   * left public at the gateway and authenticates on `sk_session` in app code.
   */
  async function refresh(req: MinimalNextRequest): Promise<Response> {
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

  function signOut(): Response {
    // Clears the browser's copy. It does not revoke the refresh token —
    // AdminUserGlobalSignOut is the tool for that, and it is an operator
    // action rather than something a page should be able to trigger.
    return json({ signedIn: false }, 200, clearCookies(appId));
  }

  async function probe(req: MinimalNextRequest): Promise<Response> {
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
  async function token(req: MinimalNextRequest): Promise<Response> {
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
        case "sign-in":
          return signIn(req);
        case "new-password":
          return newPassword(req);
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
