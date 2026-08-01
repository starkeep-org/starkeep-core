/**
 * Byte-range serving through a running local data server.
 *
 * The parser is covered separately, and passing it proves nothing about the
 * route: a `Range` header that is parsed perfectly and then never consulted
 * produces a 200 with the whole file, which every parser test still passes.
 * This is the layer where that wiring mistake shows.
 *
 * The bytes are asserted, not just the status. A 206 carrying the wrong slice
 * is worse than a 200 — the client trusts it and assembles a corrupt file.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startLocalDataServer, type LocalDataServer } from "@starkeep/testkit";
import {
  installApp,
  testAppManifest,
  createRecordWithBytes,
  type InstalledApp,
} from "./helpers.js";

let server: LocalDataServer;
let app: InstalledApp;

// Distinctive per-position content, so an off-by-one or a wrong-end read is
// visible in the assertion rather than hiding inside a run of identical bytes.
const BODY = Buffer.from(
  Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0")).join(""),
);

let fileUrl: string;

beforeAll(async () => {
  server = await startLocalDataServer();
  // Video granted here rather than in the shared fixture: this is the only
  // test that needs it, and widening the fixture would quietly hand every
  // other test an access grant it never asked for.
  app = await installApp(
    server,
    testAppManifest({
      infraRequirements: {
        fileAccess: [
          {
            types: ["video/mp4"],
            access: "readwrite",
            metadataWrite: true,
            rationale: "range serving test",
          },
        ],
      },
    }),
  );
  const { record } = await createRecordWithBytes(app, {
    bytes: BODY,
    fileName: "clip.mp4",
    type: "video/mp4",
    contentType: "video/mp4",
  });
  const res = await app.fetch(`/data/records/${record.id}/file-url`);
  fileUrl = ((await res.json()) as { url: string }).url;
}, 60_000);

afterAll(async () => {
  await server.stop();
});

const get = (range?: string) =>
  fetch(fileUrl, range ? { headers: { Range: range } } : undefined);

describe("serving bytes without a range", () => {
  it("returns the whole object and advertises that ranges are possible", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(BODY)).toBe(true);
    // Advertised on the unranged response too. A <video> element reads this
    // from the *first* response to decide whether seeking is possible; without
    // it the browser disables the scrub bar even though ranges would work.
    expect(res.headers.get("accept-ranges")).toBe("bytes");
  });
});

describe("serving a range", () => {
  it("returns 206 with exactly the requested bytes", async () => {
    const res = await get("bytes=10-19");
    expect(res.status).toBe(206);
    const body = Buffer.from(await res.arrayBuffer());
    // Ten bytes, because both ends are inclusive.
    expect(body.length).toBe(10);
    expect(body.equals(BODY.subarray(10, 20))).toBe(true);
  });

  it("reports the range and the full size in Content-Range", async () => {
    const res = await get("bytes=10-19");
    // The total after the slash is the *object* size, not the slice size —
    // it is how the player learns the duration's worth of bytes to expect.
    expect(res.headers.get("content-range")).toBe(`bytes 10-19/${BODY.length}`);
    expect(res.headers.get("content-length")).toBe("10");
  });

  it("serves the open-ended form a video element opens with", async () => {
    const res = await get("bytes=0-");
    expect(res.status).toBe(206);
    expect(Buffer.from(await res.arrayBuffer()).equals(BODY)).toBe(true);
    expect(res.headers.get("content-range")).toBe(`bytes 0-${BODY.length - 1}/${BODY.length}`);
  });

  // The seek that matters: jumping to the end of a file without reading the
  // front of it. Served from the wrong end this returns real bytes under a
  // status code claiming they are the right ones.
  it("serves a suffix range from the end of the file", async () => {
    const res = await get("bytes=-16");
    expect(res.status).toBe(206);
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(BODY.subarray(BODY.length - 16))).toBe(true);
  });

  it("clamps an end that overruns rather than failing", async () => {
    const res = await get(`bytes=${BODY.length - 5}-999999`);
    expect(res.status).toBe(206);
    expect(Buffer.from(await res.arrayBuffer()).equals(BODY.subarray(BODY.length - 5))).toBe(true);
  });

  it("answers 416 with the real length when the start is past the end", async () => {
    const res = await get(`bytes=${BODY.length + 10}-`);
    expect(res.status).toBe(416);
    // Carrying the length is what lets a client that guessed wrong correct
    // itself instead of retrying the same bad range forever.
    expect(res.headers.get("content-range")).toBe(`bytes */${BODY.length}`);
  });

  it("falls back to the whole object for a range it will not honour", async () => {
    const res = await get("bytes=0-99,200-299");
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(BODY)).toBe(true);
  });
});
