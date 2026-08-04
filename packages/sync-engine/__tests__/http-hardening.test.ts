/**
 * What each side of the wire is willing to be handed.
 *
 * Both directions had a hole and they were different holes. Inbound, the Node
 * server buffered an unbounded body and let a `SyntaxError` out as a 500 — the
 * same malformed request the cloud handler answers with a 400, so one route had
 * two behaviours depending on which end you hit. Outbound, the response was a
 * bare cast: a reply missing `hasMore` read as "drained" and stopped a sync with
 * a backlog still owed, and one missing `responderWatermarks` threw from inside
 * the engine with a stack that said nothing about the peer.
 */

import { describe, it, expect } from "vitest";
import { createServer, type Server } from "node:http";
import { createHttpSyncHandler } from "../src/transports/http-server.js";
import { createHttpSyncTransport } from "../src/transports/http-transport.js";
import { SyncError } from "../src/errors.js";
import { buildSide } from "./sync-test-harness/side.js";

type Side = Awaited<ReturnType<typeof buildSide>>;

/** A real server, because the body-reading path is the thing under test. */
async function serve(): Promise<{
  url: string;
  cloud: Side;
  close: () => Promise<void>;
}> {
  let t = 0;
  const cloud = await buildSide({ role: "cloud", nodeId: "C", wallClock: () => t++, appId: "photos" });
  const handler = createHttpSyncHandler({
    databaseAdapter: cloud.db,
    objectStorageAdapter: cloud.storage,
    clock: cloud.clock,
  });
  const server: Server = createServer((req, res) => {
    void handler(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    cloud,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

describe("the Node sync server's request bodies", () => {
  it("answers a malformed JSON body with 400, not 500", async () => {
    const s = await serve();
    try {
      const res = await fetch(`${s.url}/sync/exchange`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{ this is not json",
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/JSON/i);
    } finally {
      await s.close();
    }
  });

  it("still answers 400 for a well-formed body the sanitizer rejects", async () => {
    // The two are different failures with the same status and different
    // messages; conflating them would hide which one a peer is producing.
    const s = await serve();
    try {
      const res = await fetch(`${s.url}/sync/exchange`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ watermarks: { L: "not-an-hlc" } }),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/watermarks/);
    } finally {
      await s.close();
    }
  });

  it("refuses an oversized exchange body rather than buffering it", async () => {
    const s = await serve();
    try {
      // Comfortably over the 32 MB exchange cap, and sent as one chunk so the
      // counter has to be the thing that stops it.
      const huge = JSON.stringify({ watermarks: {}, records: ["x".repeat(40 * 1024 * 1024)] });
      const res = await fetch(`${s.url}/sync/exchange`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: huge,
      }).catch(() => null);
      // The socket is destroyed on refusal, so a client may see the 413 or may
      // see the connection go away first. Either is a refusal; what must not
      // happen is a 200 after 40 MB was read into memory.
      if (res) expect(res.status).toBe(413);
    } finally {
      await s.close();
    }
  }, 30_000);

  it("serves a file it was PUT, so the /files routes have a direct test", async () => {
    // Exercised only incidentally through the LDS e2e until now.
    const s = await serve();
    try {
      const key = "shared/image/ab/deadbeef";
      const put = await fetch(`${s.url}/files/${encodeURIComponent(key)}`, {
        method: "PUT",
        headers: { "Content-Type": "image/jpeg" },
        body: new Uint8Array([1, 2, 3]),
      });
      expect(put.status).toBe(200);

      const head = await fetch(`${s.url}/files/${encodeURIComponent(key)}`, {
        method: "HEAD",
      });
      expect(head.status).toBe(200);

      const get = await fetch(`${s.url}/files/${encodeURIComponent(key)}`);
      expect(get.status).toBe(200);
      expect(new Uint8Array(await get.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));

      const stat = await fetch(`${s.url}/files/${encodeURIComponent(key)}/stat`);
      expect(stat.status).toBe(200);
      expect((await stat.json()).sizeBytes).toBe(3);

      const del = await fetch(`${s.url}/files/${encodeURIComponent(key)}`, {
        method: "DELETE",
      });
      expect(del.status).toBe(204);
      expect(
        (await fetch(`${s.url}/files/${encodeURIComponent(key)}`, { method: "HEAD" })).status,
      ).toBe(404);
    } finally {
      await s.close();
    }
  });

  it("404s a file that is not there", async () => {
    const s = await serve();
    try {
      const res = await fetch(`${s.url}/files/shared%2Fimage%2Fab%2Fmissing`);
      expect(res.status).toBe(404);
      const stat = await fetch(`${s.url}/files/shared%2Fimage%2Fab%2Fmissing/stat`);
      expect(stat.status).toBe(404);
    } finally {
      await s.close();
    }
  });
});

describe("the response the transport is willing to believe", () => {
  function respondingWith(body: unknown) {
    const impl = (async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => body,
      text: async () => JSON.stringify(body),
    })) as unknown as typeof globalThis.fetch;
    return createHttpSyncTransport({ baseUrl: "https://cloud.example", fetch: impl });
  }

  const good = {
    records: [],
    labels: [],
    appSyncableRows: [],
    responderWatermarks: {},
    hasMore: false,
  };

  it("accepts a well-formed response", async () => {
    const response = await respondingWith(good).exchange({ watermarks: {} });
    expect(response.hasMore).toBe(false);
    expect(response.responderWatermarks).toEqual({});
  });

  it("refuses a response with no hasMore, rather than reading it as drained", async () => {
    // The quiet one. `undefined` is falsy, so the sync loop took the "both
    // directions drained" exit and reported a completed sync against a peer
    // that never said so.
    const { hasMore: _omitted, ...missing } = good;
    await expect(respondingWith(missing).exchange({ watermarks: {} })).rejects.toThrow(
      /hasMore/,
    );
  });

  it("refuses a response with no responderWatermarks", async () => {
    // This one already failed, but it failed inside `sameWatermarks` several
    // frames down, where nothing identifies the peer as the cause.
    const { responderWatermarks: _omitted, ...missing } = good;
    await expect(respondingWith(missing).exchange({ watermarks: {} })).rejects.toThrow(
      SyncError,
    );
  });

  it("fills in absent payload arrays, which an empty round legitimately omits", async () => {
    const response = await respondingWith({
      responderWatermarks: {},
      hasMore: false,
    }).exchange({ watermarks: {} });
    expect(response.records).toEqual([]);
    expect(response.labels).toEqual([]);
    expect(response.appSyncableRows).toEqual([]);
  });

  it("refuses a payload field that is present and not an array", async () => {
    await expect(
      respondingWith({ ...good, records: "nope" }).exchange({ watermarks: {} }),
    ).rejects.toThrow(/records/);
  });

  it("refuses haltedAuthors that is not a list of node ids", async () => {
    // It feeds `blocked` and repair-floor retention. A value the engine cannot
    // read would silently mean "nothing halted" — the exact failure the field
    // was added to end.
    await expect(
      respondingWith({ ...good, haltedAuthors: "L" }).exchange({ watermarks: {} }),
    ).rejects.toThrow(/haltedAuthors/);
    await expect(
      respondingWith({ ...good, haltedAuthors: [1, 2] }).exchange({ watermarks: {} }),
    ).rejects.toThrow(/haltedAuthors/);
  });

  it("carries haltedAuthors through when it is well formed", async () => {
    const response = await respondingWith({
      ...good,
      haltedAuthors: ["device-1"],
    }).exchange({ watermarks: {} });
    expect(response.haltedAuthors).toEqual(["device-1"]);
  });
});
