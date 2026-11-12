/**
 * The checks an app's local server makes on every request.
 *
 * On the local surface nothing asks who the caller is: on-device data belongs
 * to the person at the keyboard, so the signing proxy exempts local callers
 * from the session check. Binding `127.0.0.1` keeps other devices out. Pages
 * in the person's own browser still reach the server, and two kinds of them
 * must be refused before any route that signs runs:
 *
 * - **A `Host` that is not a loopback name.** DNS rebinding lets a page on an
 *   attacker's domain re-resolve that domain to `127.0.0.1` and then read this
 *   server's answers as its own. The `Host` header still carries the
 *   attacker's domain. local-data-server makes the same check
 *   (`apps/local-data-server/loopback-host.ts`).
 * - **A request from a page on another site.** A page on any site can send a
 *   blind `no-cors` POST to `127.0.0.1` with a loopback `Host`. Its
 *   `text/plain` body needs no preflight, and the data server parses it as
 *   JSON. The page cannot read the answer, but the write lands.
 *
 * Every app's local server used to copy these checks. They live here so the
 * platform applies them once: `serveLocal` from `@starkeep/app-client/local`
 * mounts them on every route, and `localSurfaceGuard` from
 * `@starkeep/app-client/hono` mounts them on a server an app builds itself.
 */

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The parts of a request the checks read. */
export interface GuardedRequest {
  method: string;
  headers: { get(name: string): string | null };
}

/** The hostname part of a `Host` value: `[::1]:4000` → `[::1]`, `localhost:4000` → `localhost`. */
function hostnameOf(host: string): string {
  const lower = host.trim().toLowerCase();
  if (lower.startsWith("[")) {
    const end = lower.indexOf("]");
    return end < 0 ? lower : lower.slice(0, end + 1);
  }
  const colon = lower.indexOf(":");
  return colon < 0 ? lower : lower.slice(0, colon);
}

/**
 * Whether a `Host` names this machine's loopback interface. A request with no
 * `Host` did not come from a browser, which always sends one, and passes.
 */
export function isLoopbackHost(host: string | null): boolean {
  if (host === null) return true;
  return LOOPBACK_HOSTNAMES.has(hostnameOf(host));
}

/**
 * Whether a browser sent this request from a page on another site, by the
 * browser's own `Sec-Fetch-Site` verdict, which no page can set.
 *
 * `same-site` counts as another site, because every port on one loopback
 * address is one site, so another local server's page is same-site. A `GET` or
 * `HEAD` navigation passes: following a link writes nothing, and the page that
 * sent the browser here cannot read the answer. That keeps admin-web's Open
 * link working. A form POST is a navigation too, and it is refused.
 *
 * A request without the header passes. It came from a server, a script, a
 * phone or a browser that predates the header; `fromAnotherOrigin` covers the
 * last of those on the local surface.
 */
export function fromAnotherSite(req: GuardedRequest): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site !== "cross-site" && site !== "same-site") return false;
  const method = req.method.toUpperCase();
  const followsLink =
    req.headers.get("sec-fetch-mode") === "navigate" && (method === "GET" || method === "HEAD");
  return !followsLink;
}

/**
 * The fallback for a browser that sends no `Sec-Fetch-Site`, such as Safari
 * before 16.4: a write whose `Origin` is not this server's own.
 *
 * A browser sends `Origin` on every cross-origin POST, `no-cors` included, and
 * sends the literal `null` from an opaque origin such as a sandboxed frame.
 * Only writes are checked, because a navigation GET carries no `Origin` and a
 * cross-origin read cannot see the answer without CORS, which this server
 * never grants. This check runs only on the local surface, where the server
 * sees the same `Host` the page used; behind CloudFront and the gateway the
 * two differ, which is why the signing proxy does not make it.
 */
export function fromAnotherOrigin(req: GuardedRequest): boolean {
  if (req.headers.get("sec-fetch-site") !== null) return false;
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
  const origin = req.headers.get("origin");
  if (origin === null) return false;
  if (origin === "null") return true;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return true;
  }
  const host = req.headers.get("host");
  return host === null || originHost.toLowerCase() !== host.trim().toLowerCase();
}

/**
 * Why the local surface refuses this request, or null when it may proceed.
 * The reason is the response body, so it names the rule without detail a
 * caller could use.
 */
export function localRequestRefusal(req: GuardedRequest): string | null {
  if (!isLoopbackHost(req.headers.get("host"))) {
    return "This app answers only on a loopback address.";
  }
  if (fromAnotherSite(req) || fromAnotherOrigin(req)) {
    return "This app refuses requests from other sites.";
  }
  return null;
}
