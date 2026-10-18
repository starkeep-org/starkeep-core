/**
 * Whether a request's `Host` names this machine's loopback interface.
 *
 * The server binds `127.0.0.1`, so only processes on this machine reach it.
 * A web page in the person's browser is one of them. DNS rebinding lets a page
 * on an attacker's domain re-resolve that domain to `127.0.0.1` and then read
 * this server's answers as its own same-origin responses; the browser sends no
 * `Origin` on a same-origin GET, so the per-route `Origin` refusals never see
 * it. The `Host` header still carries the attacker's domain, so a server that
 * answers loopback names only closes rebinding for every route at once.
 *
 * A request with no `Host` did not come from a browser, which always sends
 * one, and passes.
 */

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The hostname part of a `Host` header: `[::1]:4000` → `[::1]`, `localhost:4000` → `localhost`. */
export function hostnameOf(host: string): string {
  const lower = host.trim().toLowerCase();
  if (lower.startsWith("[")) {
    const end = lower.indexOf("]");
    return end < 0 ? lower : lower.slice(0, end + 1);
  }
  const colon = lower.indexOf(":");
  return colon < 0 ? lower : lower.slice(0, colon);
}

export function isLoopbackHost(host: string | undefined): boolean {
  if (host === undefined) return true;
  return LOOPBACK_HOSTNAMES.has(hostnameOf(host));
}
