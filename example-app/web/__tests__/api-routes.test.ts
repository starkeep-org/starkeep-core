/**
 * Route shapes that only fail in the cloud.
 *
 * API Gateway decodes `%2F` into a real slash before the data server sees the
 * path, so a path segment that holds an encoded slash reaches the server as two
 * segments. The local server never decodes, so the e2e suite cannot catch this.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMetadata } from "../src/browser/api.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getMetadata", () => {
  it("names the category, so the last segment holds no slash", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ metadata: null }), { status: 200 });
    });

    await getMetadata("REC1");

    expect(urls).toEqual(["/api/local-data/data/records/REC1/metadata/example"]);
    expect(decodeURIComponent(urls[0]!).split("/")).toHaveLength(8);
  });
});
