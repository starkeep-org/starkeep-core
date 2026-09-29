import { localDataServerUrl } from "../lib/runtime-config";

/**
 * Proxies for the daemon's stand-in routes: this node's sync-down ceilings,
 * and "Free up space".
 *
 * Proxies rather than direct browser fetches because those routes are
 * loopback-authorized: they answer to any caller on 127.0.0.1 and to nobody
 * else, which is the gate that makes them safe to serve without an app
 * identity. A browser fetch would come from the page's origin and, in any
 * deployment where admin-web is not on the same host, would simply fail — so
 * going through the server side keeps the loopback assumption true rather than
 * accidentally relying on it.
 */

async function forward(path: string, init: RequestInit): Promise<Response> {
  const base = await localDataServerUrl();
  try {
    const res = await fetch(`${base}${path}`, { ...init, cache: "no-store" });
    return Response.json(await res.json(), { status: res.status });
  } catch (err) {
    // A daemon that is not running is the ordinary state of a fresh machine.
    return Response.json(
      { error: err instanceof Error ? err.message : String(err), offline: true },
      { status: 503 },
    );
  }
}

/** This node's ceilings, the defaults per kind of node, held bytes and the backlog. */
export async function GET(): Promise<Response> {
  return forward("/residency/stand-ins", {});
}

/**
 * Save this node's ceilings. The daemon restarts to apply them, so the
 * connection may drop just after the 200 — the same as saving a policy.
 */
export async function PUT(req: Request): Promise<Response> {
  return forward("/residency/stand-ins", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: await req.text(),
  });
}

/** "Free up space", or its dry run. */
export async function POST_FREE_UP_SPACE(req: Request): Promise<Response> {
  return forward("/residency/free-up-space", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: await req.text(),
  });
}
