import { localDataServerUrlFromEnv } from "../lib/local-daemon-urls";

/**
 * An app's own data on this machine, proxied to the local-data-server.
 *
 * Uninstall keeps an app's data. These two routes are the separate action that
 * deletes it: the preview the dialog shows first, and the deletion itself.
 */

type Params = { params: Promise<{ appId: string }> };

/** Row and file counts, and whether the cloud holds a copy. */
export async function GET(_req: Request, { params }: Params) {
  const { appId } = await params;
  return forward(`/admin/apps/${encodeURIComponent(appId)}/data-preview`, { method: "GET" });
}

/**
 * Delete the data an uninstall kept. The body carries the app id the operator
 * typed, and the local-data-server refuses a mismatch, an installed app and an
 * app with no kept data.
 */
export async function POST(req: Request, { params }: Params) {
  const { appId } = await params;
  const body = (await req.json().catch(() => ({}))) as { confirm?: unknown };
  return forward(`/admin/apps/${encodeURIComponent(appId)}/delete-data`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirm: body.confirm }),
  });
}

async function forward(path: string, init: RequestInit): Promise<Response> {
  let resp: Response;
  try {
    resp = await fetch(`${localDataServerUrlFromEnv()}${path}`, init);
  } catch (err) {
    return Response.json(
      {
        error: "Could not reach local-data-server",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 502 },
    );
  }
  const text = await resp.text();
  return new Response(text, {
    status: resp.status,
    headers: { "Content-Type": "application/json" },
  });
}
