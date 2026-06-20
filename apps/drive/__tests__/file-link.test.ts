/**
 * Unit tests for the pure helpers behind Drive's in-browser file clickthrough
 * (apps/drive/src/lib/file-link.ts):
 *
 *  - `isLinkable` / `fileLinkHref` — which rows get a Name link, and where it
 *    points. The product rule is "locally available files only", so the
 *    cloud-only and no-object cases are the load-bearing ones here.
 *  - `httpContentType` — the type→Content-Type mapping that makes the browser
 *    render a file as its native kind instead of downloading an opaque blob.
 */
import { describe, it, expect } from "vitest";
import {
  isLinkable,
  fileLinkHref,
  httpContentType,
  type LinkableRecord,
} from "../src/lib/file-link";

function record(over: Partial<LinkableRecord> = {}): LinkableRecord {
  return {
    id: "rec-1",
    type: "image/jpeg",
    object_storage_key: "obj/abc",
    sync_status: "synced",
    ...over,
  };
}

describe("isLinkable — locally available files only", () => {
  it("links a synced record that has an attached object", () => {
    expect(isLinkable(record({ sync_status: "synced" }))).toBe(true);
  });

  it("links local-only and modified-locally records (bytes are on this device)", () => {
    expect(isLinkable(record({ sync_status: "local-only" }))).toBe(true);
    expect(isLinkable(record({ sync_status: "modified-locally" }))).toBe(true);
  });

  it("does NOT link a cloud-only record even though it has an object key", () => {
    // Cloud-only rows have no local bytes; the cloud proxy isn't wired for
    // file-url, so a link would 404/503.
    expect(isLinkable(record({ sync_status: "cloud-only" }))).toBe(false);
  });

  it("does NOT link a record with no attached object", () => {
    expect(isLinkable(record({ object_storage_key: null }))).toBe(false);
    expect(isLinkable(record({ object_storage_key: undefined }))).toBe(false);
  });
});

describe("fileLinkHref", () => {
  it("returns null exactly when the record is not linkable", () => {
    expect(fileLinkHref(record({ sync_status: "cloud-only" }))).toBeNull();
    expect(fileLinkHref(record({ object_storage_key: null }))).toBeNull();
  });

  it("points at the app's file route and carries the authoritative type", () => {
    const href = fileLinkHref(record({ id: "rec-1", type: "image/jpeg" }));
    expect(href).toBe("/api/records/rec-1/file?type=image%2Fjpeg");
  });

  it("url-encodes the id and tolerates a missing type", () => {
    const href = fileLinkHref(record({ id: "weird id/&?", type: undefined }));
    expect(href).toBe("/api/records/weird%20id%2F%26%3F/file?type=");
  });
});

describe("httpContentType — derive a web-renderable Content-Type", () => {
  it("maps the special Starkeep ids whose IANA type differs from the id", () => {
    expect(httpContentType("image/svg", null)).toBe("image/svg+xml");
    expect(httpContentType("image/ico", null)).toBe("image/x-icon");
    expect(httpContentType("document/pdf", null)).toBe("application/pdf");
    expect(httpContentType("document/html", null)).toBe("text/html; charset=utf-8");
    expect(httpContentType("document/markdown", null)).toBe("text/markdown; charset=utf-8");
  });

  it("serves image/video/audio ids verbatim (they coincide with IANA types)", () => {
    expect(httpContentType("image/jpeg", null)).toBe("image/jpeg");
    expect(httpContentType("image/png", null)).toBe("image/png");
    expect(httpContentType("video/mp4", null)).toBe("video/mp4");
    expect(httpContentType("audio/wav", null)).toBe("audio/wav");
  });

  it("renders text and code categories inline as UTF-8 text", () => {
    expect(httpContentType("text/plain", null)).toBe("text/plain; charset=utf-8");
    expect(httpContentType("code/typescript", null)).toBe("text/plain; charset=utf-8");
  });

  it("prefers the authoritative type over an advisory mime that disagrees", () => {
    // mime_type is advisory; the canonical type wins when it pins something.
    expect(httpContentType("image/png", "application/octet-stream")).toBe("image/png");
    expect(httpContentType("document/pdf", "text/plain")).toBe("application/pdf");
  });

  it("falls back to a meaningful advisory mime when the type pins nothing", () => {
    // Unknown category, but the watcher-supplied mime is web-renderable.
    expect(httpContentType("other/xyz", "image/gif")).toBe("image/gif");
    expect(httpContentType(undefined, "image/gif")).toBe("image/gif");
  });

  it("falls back to octet-stream when nothing is web-renderable", () => {
    expect(httpContentType(undefined, null)).toBe("application/octet-stream");
    expect(httpContentType("other/xyz", null)).toBe("application/octet-stream");
    // An advisory octet-stream is treated as "no useful hint".
    expect(httpContentType("other/xyz", "application/octet-stream")).toBe(
      "application/octet-stream",
    );
  });
});
