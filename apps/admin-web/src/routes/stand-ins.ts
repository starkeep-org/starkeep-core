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

/**
 * The integrity check, on every channel.
 *
 * On request only, which is a decision rather than an omission: it is a grouped
 * scan over each side's whole index plus a round trip, and it answers a question
 * whose answer only changes when something has already gone wrong. The cost of
 * that trade is that a row lost from the middle of an author's range — the one
 * thing a coverage watermark cannot see — sits undetected until somebody presses
 * this. The phone has had the button since before this machine had any entry point
 * at all; this is the equivalent.
 */
export async function POST_VERIFY(): Promise<Response> {
  return forward("/sync/verify", { method: "POST" });
}

/**
 * The reaper: reclaim the bytes of items deleted longer ago than the library's
 * retention window.
 *
 * The one pass that destroys something unrecoverable, so a dry run comes first —
 * it proves and totals without removing, which is the estimate a person confirms.
 */
export async function POST_REAP(req: Request): Promise<Response> {
  return forward("/residency/reap", {
    method: "POST",
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

/** The library's canonical thresholds and advisory resolutions, with the defaults and ranges. */
export async function GET_LIBRARY_STANDARDS(): Promise<Response> {
  return forward("/library/stand-in-standards", {});
}

/**
 * Change the library's values. The daemon writes a new settings file, which
 * the Drive channel carries to every node; no restart.
 */
export async function PUT_LIBRARY_STANDARDS(req: Request): Promise<Response> {
  return forward("/library/stand-in-standards", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: await req.text(),
  });
}
