/**
 * This machine's connection to a cloud: its device key, its pairing code, and
 * whether the cloud accepts it.
 *
 * The local data server holds the key and signs every call to the cloud with
 * it. These routes forward to its loopback-only `/device` routes, which never
 * return the private half, and to its `PATCH /config`, which sets the cloud a
 * machine joins and restarts the server.
 */

import { localDataServerUrl } from "../lib/runtime-config";

async function forward(path: string, init: RequestInit = {}): Promise<Response> {
  const base = await localDataServerUrl();
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

/** This machine's key, pairing code, fingerprint and approval. */
export async function GET(): Promise<Response> {
  return forward("/device");
}

/** Make this machine's key, once. Body: `{ label? }`. */
export async function POST_KEY(req: Request): Promise<Response> {
  return forward("/device/key", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: await req.text(),
  });
}

/** Ask the cloud again whether it accepts this machine's key. */
export async function POST_CHECK(): Promise<Response> {
  return forward("/device/check", { method: "POST" });
}

/**
 * Join a cloud: record its URL as this machine's cloud. The local data server
 * restarts to pick it up. Body: `{ url }`.
 */
export async function POST_CLOUD(req: Request): Promise<Response> {
  let url: unknown;
  try {
    ({ url } = (await req.json()) as { url?: unknown });
  } catch {
    return Response.json({ error: "Body is not valid JSON" }, { status: 400 });
  }
  if (typeof url !== "string" || !/^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/\S*)?$/.test(url.trim())) {
    return Response.json({ error: "The cloud address must be an https URL." }, { status: 400 });
  }
  return forward("/config", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiGatewayUrl: url.trim().replace(/\/+$/, "") }),
  });
}
