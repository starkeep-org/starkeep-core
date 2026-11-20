/**
 * This machine's connection to a cloud: the cloud it joined, and its sign-in.
 *
 * The local data server keeps this machine's sync session; these routes forward
 * to its loopback-only `/auth/*` routes, and to its `PATCH /config`, which sets
 * the cloud a machine joins and restarts the server. Signing in happens on the
 * managed login page through `/auth/start?client=device` (`routes/auth.ts`).
 *
 * The local data server refuses `/auth/*` requests that carry an `Origin`
 * header, so a web page cannot reach them directly; these forwards send none.
 * The sign-out and cloud routes here check that the request came from
 * admin-web's own page for the same reason.
 */

import { localDataServerUrlFromEnv } from "@starkeep/operator/urls";
import { crossSiteRefusal, fromOwnPage } from "../lib/same-origin";

async function forward(path: string, init: RequestInit = {}): Promise<Response> {
  const base = localDataServerUrlFromEnv();
  try {
    const res = await fetch(`${base}${path}`, { ...init, cache: "no-store" });
    return Response.json(await res.json(), { status: res.status });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err), offline: true },
      { status: 503 },
    );
  }
}

/** The cloud this machine joined, and whether it is signed in and as whom. */
export async function GET(): Promise<Response> {
  return forward("/auth/status");
}

/** Sign this machine out, here and at the pool. */
export async function POST_SIGN_OUT(req: Request): Promise<Response> {
  if (!fromOwnPage(req)) return crossSiteRefusal();
  return forward("/auth/sign-out", { method: "POST" });
}

/**
 * Join a cloud: record its URL as this machine's cloud. The local data server
 * restarts to pick it up. Body: `{ url }`.
 */
export async function POST_CLOUD(req: Request): Promise<Response> {
  if (!fromOwnPage(req)) return crossSiteRefusal();
  let url: unknown;
  try {
    ({ url } = (await req.json()) as { url?: unknown });
  } catch {
    return Response.json({ error: "Body is not valid JSON" }, { status: 400 });
  }
  if (
    typeof url !== "string" ||
    !/^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/\S*)?$/.test(url.trim())
  ) {
    return Response.json({ error: "The cloud address must be an https URL." }, { status: 400 });
  }
  return forward("/config", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiGatewayUrl: url.trim().replace(/\/+$/, "") }),
  });
}
