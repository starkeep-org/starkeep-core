/**
 * Whether a request came from admin-web's own pages.
 *
 * admin-web listens on loopback, and every web page open in the person's
 * browser can send it requests. Two checks keep other sites out, and both
 * start from the `Host` header, which names the address the request was sent
 * to:
 *
 * - **`Host` must name this machine** ({@link hostAllowed}). DNS rebinding
 *   lets a page on an attacker's domain re-resolve that domain to
 *   `127.0.0.1`. The page's requests then reach admin-web as same-origin
 *   requests, with `Host` and `Origin` both naming the attacker's domain.
 *   Refusing every `Host` but a loopback name closes that for every route.
 * - **`Origin`, when a browser sends one, must be admin-web's own**
 *   ({@link serverRefusal}, {@link fromOwnPage}). A page on another site
 *   sends its own origin.
 *
 * An operator who reaches admin-web from another device lists that device's
 * name for this host in `STARKEEP_ADMIN_DEV_ORIGINS`, as the README says. Those
 * names pass the `Host` check too, and admin-web then listens on every
 * interface (see `server.ts`).
 */

const LOOPBACK_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"];

/** The hostnames admin-web answers on. Read per call, so a test can set the variable. */
function allowedHostnames(): Set<string> {
  const extra = (process.env.STARKEEP_ADMIN_DEV_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return new Set([...LOOPBACK_HOSTNAMES, ...extra]);
}

/** The hostname part of a `Host` header: `[::1]:3000` → `[::1]`, `localhost:3000` → `localhost`. */
function hostnameOf(host: string): string {
  const lower = host.trim().toLowerCase();
  if (lower.startsWith("[")) {
    const end = lower.indexOf("]");
    return end < 0 ? lower : lower.slice(0, end + 1);
  }
  const colon = lower.indexOf(":");
  return colon < 0 ? lower : lower.slice(0, colon);
}

/** Whether a `Host` header names an address admin-web answers on. */
export function hostAllowed(host: string | null | undefined): boolean {
  if (!host) return false;
  return allowedHostnames().has(hostnameOf(host));
}

/** The parts of a request {@link serverRefusal} reads. */
export interface RequestHeaders {
  readonly method: string | undefined;
  readonly host: string | undefined;
  readonly origin: string | undefined;
}

/**
 * Why admin-web's server refuses a request before any route sees it, or null.
 *
 * A request with no `Host` did not come from a browser, which always sends
 * one, and passes. A GET or HEAD with a foreign `Origin` passes too: the
 * browser keeps the answer from the page, and the `Host` check has already
 * stopped rebinding.
 */
export function serverRefusal(req: RequestHeaders): string | null {
  if (req.host !== undefined && !hostAllowed(req.host)) {
    return "admin-web answers on this machine's own address only.";
  }
  const method = (req.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD" || req.origin === undefined) return null;
  if (req.host !== undefined && req.origin === `http://${req.host}`) return null;
  return "This request must come from admin-web's own page.";
}

/**
 * Whether a request came from admin-web's own page, for the routes that act on
 * the person's behalf, such as signing this machine in. Browsers send `Origin`
 * on every POST, so a POST whose `Origin` is not this server's own origin came
 * from somewhere else. A POST with no `Origin` did not come from a browser page
 * and is refused too: these routes have no other caller.
 *
 * The route's own origin comes from `Host`, so the `Host` must pass
 * {@link hostAllowed} as well. Otherwise a rebinding page, whose `Host` and
 * `Origin` both name the attacker's domain, would match.
 */
export function fromOwnPage(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  const own = new URL(req.url);
  return hostAllowed(own.host) && origin === own.origin;
}

/** The answer a route gives a request {@link fromOwnPage} refuses. */
export function crossSiteRefusal(): Response {
  return Response.json(
    { error: "This request must come from admin-web's own page." },
    { status: 403 },
  );
}
