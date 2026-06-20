/**
 * Pure, framework-free helpers that back Drive's in-browser file clickthrough.
 *
 * This module is deliberately free of `node:*` and `server-only` imports so it
 * can be shared by both the client listing page (which decides whether a row is
 * a link and where it points) and the server route (which decides what
 * Content-Type to serve the bytes under). Keeping the contract in one place
 * stops the two sides from drifting.
 */

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
export function httpContentType(type: string | undefined, advisoryMime: string | null): string {
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

export type SyncStatus = "local-only" | "synced" | "modified-locally" | "cloud-only";

/** The minimal slice of a Drive row the link helpers need. */
export interface LinkableRecord {
  id: string;
  type?: string | null;
  object_storage_key?: string | null;
  sync_status: SyncStatus;
}

/**
 * Whether Drive can stream a record's bytes back to the browser. True only when
 * the file is on this device: any local sync status with an attached object.
 * Cloud-only rows have no local bytes (the cloud proxy isn't wired for
 * file-url), and a record with no `object_storage_key` has nothing to link.
 */
export function isLinkable(r: LinkableRecord): boolean {
  return r.sync_status !== "cloud-only" && !!r.object_storage_key;
}

/**
 * The in-app URL that streams a record's bytes inline, or `null` when the
 * record isn't locally available (see {@link isLinkable}). The `type` query
 * param carries the record's authoritative Starkeep type so the route can pick
 * a web-renderable Content-Type without re-deriving it.
 */
export function fileLinkHref(r: LinkableRecord): string | null {
  if (!isLinkable(r)) return null;
  return `/api/records/${encodeURIComponent(r.id)}/file?type=${encodeURIComponent(r.type ?? "")}`;
}
