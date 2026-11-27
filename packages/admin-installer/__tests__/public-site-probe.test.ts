/**
 * The cloud install's check of a public site's address, and the update it
 * names when the deployment predates public sites.
 */
import { describe, it, expect, vi } from "vitest";
import { probePublicSite } from "../src/public-site-probe";

const fast = { attempts: 2, delayMs: 0 };

describe("probePublicSite", () => {
  // SITES-008
  it("reports the site's address and that it answered", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>", { status: 200 }));
    const result = await probePublicSite("https://d1.cloudfront.net/", "blog", fetchImpl, fast);
    expect(result).toEqual({
      url: "https://d1.cloudfront.net/sites/blog/",
      status: 200,
      ok: true,
      advice: null,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  // SITES-015
  it.each([404, 403])(
    "names the bootstrap update and the cloud data server reinstall on a %i",
    async (status) => {
      const fetchImpl = vi.fn(async () => new Response("no", { status }));
      const result = await probePublicSite("https://d1.cloudfront.net", "blog", fetchImpl, fast);
      expect(result.ok).toBe(false);
      expect(result.status).toBe(status);
      expect(result.advice).toMatch(/predates public sites/);
      expect(result.advice).toMatch(
        /Update the bootstrap stack.*then reinstall the cloud data server/,
      );
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    },
  );

  it("retries a site that answers on a later try", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("no", { status: 404 }))
      .mockResolvedValueOnce(new Response("<html>", { status: 200 }));
    const result = await probePublicSite("https://d1.cloudfront.net", "blog", fetchImpl, fast);
    expect(result.ok).toBe(true);
  });

  it("reports no status when the address never answers", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const result = await probePublicSite("https://d1.cloudfront.net", "blog", fetchImpl, fast);
    expect(result).toMatchObject({ ok: false, status: null });
  });
});
