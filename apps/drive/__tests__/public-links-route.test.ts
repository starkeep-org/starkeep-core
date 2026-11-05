/**
 * Tests for Drive's `/api/public-links` routes.
 *
 * The platform owns every rule a public link obeys, so what the route adds is
 * small and all of it is here: the browser names a record, the platform's
 * answers (a refused switch, an archived original) reach the page with their
 * status, a link's address is the platform's direct link under the cloud's
 * address, and a write from another site's page is refused before it reaches
 * the platform.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class DriveNotInstalledError extends Error {}
  class LdsResponseError extends Error {
    constructor(
      readonly status: number,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    listPublicShares: vi.fn(),
    createPublicShare: vi.fn(),
    updatePublicShare: vi.fn(),
    deletePublicShare: vi.fn(),
    DriveNotInstalledError,
    LdsResponseError,
  };
});

vi.mock("../src/lib/drive-client", () => mocks);

import { cloudBaseUrl, DELETE, GET, PATCH, POST } from "../src/routes/public-links";

const SHARE_ID = "0b9c7c58-6a43-4b37-9f6e-0f5f1a7c2a11";

function share(over: Record<string, unknown> = {}) {
  return {
    id: SHARE_ID,
    linkToken: "T".repeat(22),
    source: { kind: "record", recordId: "rec-1" },
    serves: "original",
    title: "Trip notes",
    createdAtMs: 1,
    expiresAtMs: null,
    ...over,
  };
}

function json(method: string, body: unknown, type = "application/json") {
  return new Request("http://localhost:9830/api/public-links", {
    method,
    headers: { "content-type": type },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  for (const fn of [
    mocks.listPublicShares,
    mocks.createPublicShare,
    mocks.updatePublicShare,
    mocks.deletePublicShare,
  ]) {
    fn.mockReset();
  }
});

describe("cloudBaseUrl", () => {
  it("prefers the CloudFront address and trims a trailing slash", () => {
    const read = () =>
      JSON.stringify({ publicBaseUrl: "https://d1.cloudfront.net/", apiGatewayUrl: "https://gw" });
    expect(cloudBaseUrl(read)).toBe("https://d1.cloudfront.net");
  });

  it("is null without a cloud, or with an address that is not https", () => {
    expect(
      cloudBaseUrl(() => {
        throw new Error("ENOENT");
      }),
    ).toBeNull();
    expect(cloudBaseUrl(() => JSON.stringify({ publicBaseUrl: "http://x" }))).toBeNull();
  });
});

describe("GET /api/public-links", () => {
  it("lists record links only, with the switch's state", async () => {
    mocks.listPublicShares.mockResolvedValue({
      mayPublish: false,
      publicShares: [share(), share({ id: "x", source: { kind: "label", key: "k", value: "v" } })],
    });
    const body = (await (await GET()).json()) as {
      available: boolean;
      mayPublish: boolean;
      links: Array<{ recordId: string; serves: string }>;
    };
    expect(body.available).toBe(true);
    expect(body.mayPublish).toBe(false);
    expect(body.links).toEqual([
      expect.objectContaining({ recordId: "rec-1", serves: "original" }),
    ]);
  });

  it("says why links are unavailable rather than failing the page", async () => {
    mocks.listPublicShares.mockRejectedValue(new Error("This computer is not signed in"));
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      available: false,
      reason: "This computer is not signed in",
    });
  });
});

describe("POST /api/public-links", () => {
  it("names the record and passes the choice through", async () => {
    mocks.createPublicShare.mockResolvedValue(share());
    const res = await POST(
      json("POST", { recordId: "rec-1", serves: "original", title: "Trip notes", lifetime: "7d" }),
    );
    expect(res.status).toBe(201);
    expect(mocks.createPublicShare).toHaveBeenCalledWith({
      recordId: "rec-1",
      serves: "original",
      title: "Trip notes",
      lifetime: "7d",
    });
    const { link } = (await res.json()) as { link: { url: string | null } };
    expect(link.url === null || link.url.endsWith(`/public-shares/${"T".repeat(22)}/file`)).toBe(
      true,
    );
  });

  it("defaults to the stand-in", async () => {
    mocks.createPublicShare.mockResolvedValue(share({ serves: "stand-in" }));
    await POST(json("POST", { recordId: "rec-1", serves: "anything", title: "x" }));
    expect(mocks.createPublicShare).toHaveBeenCalledWith(
      expect.objectContaining({ serves: "stand-in", lifetime: "30d" }),
    );
  });

  it("passes the platform's refusal through with its status", async () => {
    mocks.createPublicShare.mockRejectedValue(
      new mocks.LdsResponseError(
        409,
        "This original is archived. Share the largest stand-in instead.",
      ),
    );
    const res = await POST(json("POST", { recordId: "rec-1", serves: "original", title: "x" }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("archived");
  });

  it("refuses a body another site's page could send without asking", async () => {
    const res = await POST(json("POST", { recordId: "rec-1", title: "x" }, "text/plain"));
    expect(res.status).toBe(415);
    expect(mocks.createPublicShare).not.toHaveBeenCalled();
  });

  it("requires a record", async () => {
    expect((await POST(json("POST", { title: "x" }))).status).toBe(400);
  });
});

describe("PATCH and DELETE /api/public-links/:id", () => {
  it("change only what was asked", async () => {
    mocks.updatePublicShare.mockResolvedValue(share());
    await PATCH(json("PATCH", { lifetime: "1d", rotateLink: true, serves: "original" }), SHARE_ID);
    expect(mocks.updatePublicShare).toHaveBeenCalledWith(SHARE_ID, {
      lifetime: "1d",
      rotateLink: true,
    });
  });

  it("refuse a cross-site body and an id that is not a share's", async () => {
    expect((await PATCH(json("PATCH", { lifetime: "1d" }, "text/plain"), SHARE_ID)).status).toBe(
      415,
    );
    expect((await PATCH(json("PATCH", { lifetime: "1d" }), "../x")).status).toBe(404);
    expect((await DELETE("../x")).status).toBe(404);
    expect(mocks.updatePublicShare).not.toHaveBeenCalled();
    expect(mocks.deletePublicShare).not.toHaveBeenCalled();
  });

  it("stop sharing", async () => {
    mocks.deletePublicShare.mockResolvedValue(undefined);
    expect(await (await DELETE(SHARE_ID)).json()).toEqual({ deleted: SHARE_ID });
  });
});
