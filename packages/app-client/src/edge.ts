/**
 * The origin gate, as Next middleware.
 *
 * Edge-safe by construction: this module imports nothing but `auth/verify.ts`,
 * because OpenNext runs middleware in an edge runtime where `node:crypto` and
 * the AWS SDK are unavailable.
 *
 * It is deny-by-default. A path the app has not declared public is refused,
 * which inverts the shape that produced the 2026-08 exposure — there, a public
 * catch-all was wider than the declaration sitting beside it, and every route
 * an app added was anonymous until someone noticed.
 *
 * This is a gate, not *the* gate. After the platform session authorizer lands
 * at the API Gateway, the enforcement that matters happens before a request
 * reaches app code at all. This stays because it is the only gate on the local
 * surface, where there is no gateway, and because it still applies if a
 * `publicPaths` entry is ever declared wider than intended.
 */

export interface AuthGateOptions {
  /** From the app's manifest — never a hand-maintained second copy. */
  publicPaths: string[];
  /** App-relative, e.g. `/sign-in`. */
  signInPath: string;
  /** e.g. `/apps/memo`; empty when the app is served at the root. */
  basePath?: string;
  /**
   * Cookie whose mere presence lets a request through. The middleware does not
   * verify it: the route handlers and the proxy do, and a JWKS fetch here would
   * put a network call in front of every request. Presence is enough to decide
   * "send this person to sign-in" from "let the real gate answer".
   */
  cookieName?: string;
}

const DEFAULT_COOKIE = "sk_session";

function pathAllowed(pathname: string, publicPaths: string[]): boolean {
  for (const entry of publicPaths) {
    if (entry.endsWith("/*")) {
      const prefix = entry.slice(0, -1); // keep the trailing slash
      if (pathname === entry.slice(0, -2) || pathname.startsWith(prefix)) return true;
    } else if (pathname === entry) {
      return true;
    }
  }
  return false;
}

function hasCookie(req: Request, name: string): boolean {
  const header = req.headers.get("cookie");
  if (!header) return false;
  return header.split(";").some((part) => part.trim().startsWith(`${name}=`));
}

export function createAuthGateMiddleware(opts: AuthGateOptions) {
  const cookieName = opts.cookieName ?? DEFAULT_COOKIE;
  const basePath = opts.basePath ?? "";

  return function authGate(req: Request): Response | undefined {
    // Local mode has no second party to authenticate against, and gating
    // on-device data behind a sign-in would break the local-first guarantee.
    if (process.env.STARKEEP_APP_CLIENT_MODE !== "cloud") return undefined;

    const url = new URL(req.url);
    let pathname = url.pathname;
    if (basePath && pathname.startsWith(basePath)) {
      pathname = pathname.slice(basePath.length) || "/";
    }

    if (pathAllowed(pathname, opts.publicPaths)) return undefined;
    if (hasCookie(req, cookieName)) return undefined;

    // A navigation gets a redirect it can act on; anything else gets the 401
    // its caller is expecting. An XHR handed an HTML sign-in page parses it as
    // a corrupt response rather than as "you are signed out".
    const dest = req.headers.get("sec-fetch-dest");
    const isDocument = dest === "document" || (dest === null && req.method === "GET");
    if (isDocument) {
      return new Response(null, {
        status: 302,
        headers: { Location: `${basePath}${opts.signInPath}` },
      });
    }
    return new Response(JSON.stringify({ error: "Not authenticated" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  };
}
