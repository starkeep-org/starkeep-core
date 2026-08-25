/**
 * File responses are cacheable, and the URL is stable enough for that to
 * matter.
 *
 * The second half is the whole point. `Cache-Control` on its own changed
 * nothing across reloads: the token baked `now + ttl` into its payload, so
 * every call minted a different URL for the same key, and the browser cache
 * keys on the full URL. A fresh page load asked for hundreds of URLs it had
 * never seen and re-downloaded the entire visible grid however generous the
 * max-age. Quantising the expiry is what turns the header into a cache hit.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startLocalDataServer, type LocalDataServer } from "@starkeep/testkit";
import { installApp, testAppManifest, createRecordWithBytes, type InstalledApp } from "./helpers.js";

let server: LocalDataServer;
let app: InstalledApp;
let recordId: string;

beforeAll(async () => {
  server = await startLocalDataServer();
  app = await installApp(server, testAppManifest());
  const { record } = await createRecordWithBytes(app, {
    bytes: Buffer.from("some image bytes"),
    fileName: "tile.jpg",
  });
  recordId = record.id;
}, 60_000);

afterAll(async () => {
  await server.stop();
});

const fileUrl = async () =>
  ((await (await app.fetch(`/data/records/${recordId}/file-url`)).json()) as { url: string }).url;

describe("the signed URL", () => {
  it("is identical across separate calls for the same key", async () => {
    const first = await fileUrl();
    // Far enough apart that an unquantised `now + ttl` would differ.
    await new Promise((r) => setTimeout(r, 1100));
    expect(await fileUrl()).toBe(first);
  }, 30_000);

  it("still carries an expiry that is in the future", async () => {
    const url = await fileUrl();
    const token = url.slice(url.lastIndexOf("/") + 1);
    const payload = Buffer.from(token.slice(0, token.indexOf(".")), "base64url").toString();
    const expires = Number(payload.split("|")[3]);
    expect(expires).toBeGreaterThan(Date.now() / 1000);
  }, 30_000);
});

describe("the file response", () => {
  it("is cacheable for as long as its URL works, and no longer", async () => {
    const url = await fileUrl();
    const res = await fetch(url);
    expect(res.status).toBe(200);
    const cacheControl = res.headers.get("cache-control") ?? "";

    expect(cacheControl).toContain("private");
    expect(cacheControl).toContain("immutable");
    expect(cacheControl).not.toContain("no-store");

    const maxAge = Number(/max-age=(\d+)/.exec(cacheControl)?.[1]);
    const token = url.slice(url.lastIndexOf("/") + 1);
    const payload = Buffer.from(token.slice(0, token.indexOf(".")), "base64url").toString();
    const expires = Number(payload.split("|")[3]);
    // Caching past the point the URL stops working would store a response
    // nothing can ever ask for again.
    expect(maxAge).toBeGreaterThan(0);
    expect(maxAge).toBeLessThanOrEqual(Math.ceil(expires - Date.now() / 1000));
  }, 30_000);
});
