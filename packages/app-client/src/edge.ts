/**
 * The origin gate.
 *
 * One function of `Request -> Response | undefined`: a refusal, or nothing to
 * say. That signature is a framework's middleware in every framework worth the
 * name — a Hono middleware via `honoOriginGate`, or an `if` at the top of a
 * hand-written server — so the gate itself names none of them.
 *
 * Dependency-free by construction: this module imports nothing at all, because
 * it has run in an edge runtime where `node:crypto` and the AWS SDK are
 * unavailable, and because keeping it that way is what lets every surface mount
 * the same copy.
 *
 * It is deny-by-default. A path the app has not declared public is refused,
 * which inverts the shape that produced the 2026-08 exposure — there, a public
 * catch-all was wider than the declaration sitting beside it, and every route
 * an app added was anonymous until someone noticed.
 *
 * This is a gate, not *the* gate, and it is a cloud gate only. Its first line
 * returns `undefined` unless `STARKEEP_APP_CLIENT_MODE` is `cloud`, so on the
 * local surface it refuses nothing: the browser, the data and the person are
 * all on one machine, which is the local-first guarantee the platform makes and
 * the same reason `sessionAuth()` defaults `allowAnonymousLocal` to true. In
 * the cloud the enforcement that matters is the platform session authorizer at
 * the API Gateway, which runs before a request reaches app code at all. This
 * stays because it still applies if a `publicPaths` entry is ever declared
 * wider than intended, and because an app served outside the gateway has
 * nothing else.
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

export function createOriginGate(opts: AuthGateOptions): (req: Request) => Response | undefined {
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
      // Absolute, resolved against the request. A path-only Location is legal
      // HTTP and still the wrong thing to emit here: a caller that parses it
      // with `new URL(...)` throws on a relative value, which surfaces as a 500
      // on the auth path, where an outage and a refusal must not look alike.
      return new Response(null, {
        status: 302,
        headers: { Location: new URL(`${basePath}${opts.signInPath}`, url).toString() },
      });
    }
    return new Response(JSON.stringify({ error: "Not authenticated" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  };
}
