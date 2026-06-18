import { LDS_URL } from "../../../src/lib/drive-client";

// Long-lived SSE stream — never statically optimized or cached.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Same-origin SSE proxy to the local-data-server `/events` stream. `/events` is
 * a loopback-authorized LDS route (no HMAC), so the Drive server pipes it
 * straight through to the browser — the page can't open an EventSource to the
 * LDS directly (cross-origin, and the browser can't sign). Each kick lets the
 * Drive page re-fetch types/records so it live-updates when a record is added
 * underneath it (by another app or the watcher).
 *
 * The request's abort signal is forwarded upstream, so when the browser closes
 * the EventSource the LDS connection is torn down too.
 */
export async function GET(req: Request): Promise<Response> {
  let upstream: Response;
  try {
    upstream = await fetch(`${LDS_URL}/events`, {
      headers: { Accept: "text/event-stream" },
      signal: req.signal,
      cache: "no-store",
    });
  } catch (err) {
    return new Response(
      `event: error\ndata: ${JSON.stringify(err instanceof Error ? err.message : String(err))}\n\n`,
      { status: 502, headers: { "Content-Type": "text/event-stream" } },
    );
  }

  if (!upstream.ok || !upstream.body) {
    return new Response(
      `event: error\ndata: "local-data-server /events unavailable (${upstream.status})"\n\n`,
      { status: 502, headers: { "Content-Type": "text/event-stream" } },
    );
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
