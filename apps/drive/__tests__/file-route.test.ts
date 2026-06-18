/**
 * Tests for GET /api/records/[id]/file — the route that streams a record's
 * bytes back to the browser inline so the Drive Name link opens the file as its
 * native kind.
 *
 * `getFileUrl` (which talks to the local-data-server, signed as Drive) and the
 * upstream `fetch` of the resolved URL are both mocked, so these tests pin the
 * route's own behaviour: how it derives headers and how it maps failures to
 * status codes — without standing up an LDS or real object storage.
 */
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";

// Hoisted so the (also-hoisted) vi.mock factory can close over them. The route
// distinguishes "not installed" with `instanceof`, so a hand-rolled stand-in
// must be the *same* class the route imports — hence it lives in the mock.
const { getFileUrl, DriveNotInstalledError } = vi.hoisted(() => {
  class DriveNotInstalledError extends Error {
    constructor() {
      super("not installed");
      this.name = "DriveNotInstalledError";
    }
  }
  return { getFileUrl: vi.fn(), DriveNotInstalledError };
});

vi.mock("../src/lib/drive-client", () => ({
  getFileUrl,
  DriveNotInstalledError,
}));

import { GET } from "../app/api/records/[id]/file/route";

/** Build the (req, ctx) pair the route expects from an id + query string. */
function call(id: string, query = "") {
  const req = {
    nextUrl: new URL(`http://drive.local/api/records/${id}/file${query}`),
  } as unknown as Parameters<typeof GET>[0];
  return GET(req, { params: Promise.resolve({ id }) });
}

const realFetch = globalThis.fetch;

beforeEach(() => {
  getFileUrl.mockReset();
  globalThis.fetch = vi.fn() as unknown as typeof fetch;
});

function mockUpstream(res: Response) {
  (globalThis.fetch as unknown as Mock).mockResolvedValue(res);
}

describe("GET file route — success path", () => {
  it("streams the bytes inline under a type derived from the record's type", async () => {
    getFileUrl.mockResolvedValue({ url: "http://lds/token", mimeType: null });
    mockUpstream(new Response("PNGDATA", { status: 200, headers: { "content-length": "7" } }));

    const res = await call("rec-1", "?type=image%2Fpng");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Content-Disposition")).toBe("inline");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("Content-Length")).toBe("7");
    expect(await res.text()).toBe("PNGDATA");
  });

  it("resolves the bytes for the requested record id", async () => {
    getFileUrl.mockResolvedValue({ url: "http://lds/token", mimeType: null });
    mockUpstream(new Response("x", { status: 200 }));

    await call("rec-42", "?type=image%2Fpng");

    expect(getFileUrl).toHaveBeenCalledWith("rec-42");
    expect(globalThis.fetch).toHaveBeenCalledWith("http://lds/token", {
      cache: "no-store",
    });
  });

  it("omits Content-Length when the upstream doesn't supply one", async () => {
    getFileUrl.mockResolvedValue({ url: "http://lds/token", mimeType: null });
    mockUpstream(new Response("hello", { status: 200 }));

    const res = await call("rec-1", "?type=text%2Fplain");

    expect(res.headers.get("Content-Length")).toBeNull();
    expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
  });

  it("falls back to the advisory mime when no type is supplied", async () => {
    getFileUrl.mockResolvedValue({ url: "http://lds/token", mimeType: "image/gif" });
    mockUpstream(new Response("GIF", { status: 200 }));

    const res = await call("rec-1");

    expect(res.headers.get("Content-Type")).toBe("image/gif");
  });
});

describe("GET file route — failure mapping", () => {
  it("returns 503 when Drive isn't installed locally", async () => {
    getFileUrl.mockRejectedValue(new DriveNotInstalledError());

    const res = await call("rec-1", "?type=image%2Fpng");

    expect(res.status).toBe(503);
    expect(await res.text()).toContain("not installed");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("returns 502 for any other resolve error (e.g. no attached file)", async () => {
    getFileUrl.mockRejectedValue(new Error("Record has no attached file"));

    const res = await call("rec-1", "?type=image%2Fpng");

    expect(res.status).toBe(502);
    expect(await res.text()).toContain("no attached file");
  });

  it("returns 502 with the upstream body when the byte fetch fails", async () => {
    getFileUrl.mockResolvedValue({ url: "http://lds/token", mimeType: null });
    mockUpstream(new Response("token expired", { status: 403 }));

    const res = await call("rec-1", "?type=image%2Fpng");

    expect(res.status).toBe(502);
    expect(await res.text()).toBe("token expired");
  });
});

// Restore the real fetch so this suite doesn't leak its mock into others.
afterEach(() => {
  globalThis.fetch = realFetch;
});
