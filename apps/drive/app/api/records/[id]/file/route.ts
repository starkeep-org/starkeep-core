import { NextRequest } from "next/server";
import { getFileUrl, DriveNotInstalledError } from "../../../../../src/lib/drive-client";

/**
 * A few canonical Starkeep type ids whose IANA media type differs from the id
 * itself (the id is Starkeep's own namespace, deliberately *not* IANA MIME).
 * Everything not listed is handled by category in {@link httpContentType}.
 */
const TYPE_CONTENT_TYPE: Record<string, string> = {
  "image/svg": "image/svg+xml",
  "image/ico": "image/x-icon",
  "document/pdf": "application/pdf",
  "document/html": "text/html; charset=utf-8",
  "document/markdown": "text/markdown; charset=utf-8",
};

/**
 * Pick the HTTP `Content-Type` to serve a record's bytes under, so the browser
 * renders the file as its native kind instead of downloading an opaque blob.
 *
 * We derive this from the record's authoritative `type` (the canonical
 * `<category>/<format>` id), NOT from `mime_type`: mime_type is advisory and is
 * frequently absent — e.g. a file the filesystem watcher ingested directly,
 * with no app to declare it. The advisory mime is only a last-resort hint when
 * the authoritative type pins nothing web-renderable.
 */
function httpContentType(type: string | undefined, advisoryMime: string | null): string {
  if (type) {
    const explicit = TYPE_CONTENT_TYPE[type];
    if (explicit) return explicit;
    const category = type.split("/")[0];
    // image/jpeg, image/png, video/mp4, audio/wav, … mostly coincide with their
    // IANA media types; serve the id and let the browser render what it can.
    if (category === "image" || category === "video" || category === "audio") {
      return type;
    }
    // Source and plain-text formats render inline as UTF-8 text.
    if (category === "text" || category === "code") {
      return "text/plain; charset=utf-8";
    }
  }
  return advisoryMime && advisoryMime !== "application/octet-stream"
    ? advisoryMime
    : "application/octet-stream";
}

/**
 * Resolve a record's bytes (signed as Drive, server-side) and stream them back
 * inline under a content-type derived from the record's canonical type, so the
 * Name link opens the file as its native kind. Only records with bytes on this
 * device resolve here (local-only / synced); anything else surfaces the LDS
 * error. `type` is passed by the listing page, which already holds the
 * authoritative value — it only steers presentation of the user's own bytes.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
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
