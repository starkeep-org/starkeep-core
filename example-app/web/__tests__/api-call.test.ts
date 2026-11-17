/**
 * How every page request is sent: through the request gate when it goes to
 * the app's own server, and straight out when it goes to a signed URL.
 *
 * Only the app's own server runs on Lambda, so only its requests share the
 * concurrency limit the gate protects. A throttled request is sent again, and
 * each attempt lands in the Activity table on its own, so the page shows the
 * 503 and then the retry's answer.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { activityEntries } from "../src/browser/activity.js";
import * as api from "../src/browser/api.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a request to the app's own server", () => {
  it("is sent again after a 503, and each attempt is logged", async () => {
    const statuses = [503, 200];
    const sent: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      sent.push(url);
      return Response.json(
        { types: [{ record_type: "example/plaintext", count: 1 }] },
        {
          status: statuses.shift()!,
        },
      );
    });

    expect(await api.types()).toEqual([{ record_type: "example/plaintext", count: 1 }]);

    expect(sent).toEqual(["/api/local-data/data/types", "/api/local-data/data/types"]);
    // Newest first: the retry's 200 above the throttled 503.
    expect(
      activityEntries()
        .slice(0, 2)
        .map((e) => [e.method, e.path, e.status]),
    ).toEqual([
      ["GET", "/data/types", 200],
      ["GET", "/data/types", 503],
    ]);
  });
});

describe("a request to a signed URL", () => {
  it("skips the gate, so a 503 is not sent again", async () => {
    const sent: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      sent.push(url);
      return url.startsWith("https://")
        ? new Response("Slow down", { status: 503 })
        : Response.json({ url: "https://bucket.example/signed" });
    });

    await expect(api.readContent("REC1")).rejects.toMatchObject({ status: 503 });

    expect(sent).toEqual([
      "/api/local-data/data/records/REC1/file-url",
      "https://bucket.example/signed",
    ]);
    expect(activityEntries()[0]).toMatchObject({
      method: "GET",
      path: "GET <signed file URL>",
      status: 503,
    });
  });
});
