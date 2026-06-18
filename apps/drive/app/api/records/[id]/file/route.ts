import { NextRequest } from "next/server";
import { getFileUrl, DriveNotInstalledError } from "../../../../../src/lib/drive-client";
import { httpContentType } from "../../../../../src/lib/file-link";

/**
 * Resolve a record's bytes (signed as Drive, server-side) and stream them back
 * inline under a content-type derived from the record's canonical type, so the
 * Name link opens the file as its native kind. Only records with bytes on this
 * device resolve here (local-only / synced); anything else surfaces the LDS
 * error. `type` is passed by the listing page, which already holds the
 * authoritative value — it only steers presentation of the user's own bytes.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const type = req.nextUrl.searchParams.get("type") ?? undefined;
  try {
    const { url, mimeType } = await getFileUrl(id);
    const upstream = await fetch(url, { cache: "no-store" });
    if (!upstream.ok || !upstream.body) {
      const body = await upstream.text().catch(() => "");
      return new Response(body || `Upstream ${upstream.status}`, {
        status: 502,
      });
    }
    const headers = new Headers({
      "Content-Type": httpContentType(type, mimeType),
      "Content-Disposition": "inline",
      "Cache-Control": "private, no-store",
    });
    const len = upstream.headers.get("content-length");
    if (len) headers.set("Content-Length", len);
    return new Response(upstream.body, { headers });
  } catch (err) {
    const status = err instanceof DriveNotInstalledError ? 503 : 502;
    return new Response(err instanceof Error ? err.message : String(err), {
      status,
    });
  }
}
