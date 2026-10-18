/**
 * Whether a request came from admin-web's own pages.
 *
 * admin-web listens on loopback, and every web page open in the person's
 * browser can send it requests. A route that acts on the person's behalf —
 * signing this machine in, for one — must refuse a request another site sent.
 * Browsers send `Origin` on every POST, so a POST whose `Origin` is not this
 * server's own origin came from somewhere else. A POST with no `Origin` did not
 * come from a browser page and is refused too: these routes have no other
 * caller.
 */
export function fromOwnPage(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  return origin === new URL(req.url).origin;
}

/** The answer a route gives a request {@link fromOwnPage} refuses. */
export function crossSiteRefusal(): Response {
  return Response.json({ error: "This request must come from admin-web's own page." }, { status: 403 });
}
