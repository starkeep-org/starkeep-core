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

/**
 * A real server, because the body-reading path is the thing under test.
 *
 * `caps` exists for the file limit: it is 2 GB, so the only way to see the
 * refusal without pushing two gigabytes through a socket is to hand the handler
 * a smaller number. What is under test is the counting and the refusal; the
 * number itself is not.
 */
async function serve(
  caps: { maxExchangeBodyBytes?: number; maxFileBodyBytes?: number } = {},
): Promise<{
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
    ...caps,
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
      const outcome = await fetch(`${s.url}/sync/exchange`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: huge,
      })
        .then((res) => ({ kind: "answered" as const, status: res.status }))
        .catch((err: { cause?: { code?: string } }) => ({
          kind: "closed" as const,
          code: err.cause?.code ?? "unknown",
        }));

      // Named outcomes rather than `if (res)`. A body this size is still being
      // written when the refusal lands, so the sender either reads the 413 or
      // hits the closed socket first — both are refusals, and which one happens
      // is a race. The old form wrapped the 413 assertion in `if (res)`, which
      // meant the test checked nothing at all whenever the socket won, which
      // was most of the time. Spelling both out is what makes it assert
      // something: what must not happen is a 200, and what must not happen is
      // an outcome that is neither.
      if (outcome.kind === "answered") expect(outcome.status).toBe(413);
      else expect(outcome.code).toMatch(/EPIPE|ECONNRESET|UND_ERR_SOCKET/);

      // And the server is still serving: refusing a body must cost that
      // request and nothing else.
      const after = await fetch(`${s.url}/sync/exchange`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ watermarks: {} }),
      });
      expect(after.status).toBe(200);
    } finally {
      await s.close();
    }
  }, 30_000);

  it("answers 413 with a reason when the sender is done writing", async () => {
    // The deterministic half of the case above, and the one a peer actually
    // sees: a body over the cap but small enough to be fully in flight before
    // the refusal lands gets a real status and a real message. This is only
    // reliable because the server now writes the response *before* it destroys
    // the socket — the other order raced the answer away.
    const s = await serve({ maxExchangeBodyBytes: 1024 });
    try {
      const res = await fetch(`${s.url}/sync/exchange`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ watermarks: {}, records: ["x".repeat(4096)] }),
      });
      expect(res.status).toBe(413);
      expect((await res.json()).error).toMatch(/exceeds 1024 bytes/);
    } finally {
      await s.close();
    }
  });

  describe("the file-body cap", () => {
    // `PUT /files/:key` is where bytes actually cross the wire, and its cap had
    // no test at all — the 2 GB figure is exactly why. The exchange cap, at 32
    // MB, was testable by brute force; this one was not, so the one route where
    // unbounded buffering would actually cost something went unchecked.
    const serveWithCap = (limit: number) => serve({ maxFileBodyBytes: limit });

    const KEY = "shared/image/ab/deadbeef";

    it("answers 413 for a body over the cap", async () => {
      const s = await serveWithCap(1024);
      try {
        const res = await fetch(`${s.url}/files/${encodeURIComponent(KEY)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/octet-stream" },
          body: new Uint8Array(4096),
        });
        expect(res.status).toBe(413);
        expect((await res.json()).error).toMatch(/exceeds 1024 bytes/);
      } finally {
        await s.close();
      }
    });

    it("stores nothing when it refuses", async () => {
      // The half that matters. A refusal that had already written a truncated
      // object would leave a content-addressed key holding bytes that do not
      // hash to it, and every later reader would treat that as corruption.
      const s = await serveWithCap(1024);
      try {
        await fetch(`${s.url}/files/${encodeURIComponent(KEY)}`, {
          method: "PUT",
          body: new Uint8Array(4096),
        });
        expect(await s.cloud.storage.has(KEY)).toBe(false);
      } finally {
        await s.close();
      }
    });

    it("still accepts a body at the cap", async () => {
      // A cap that refused everything would pass both cases above.
      const s = await serveWithCap(1024);
      try {
        const res = await fetch(`${s.url}/files/${encodeURIComponent(KEY)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/octet-stream" },
          body: new Uint8Array(1024),
        });
        expect(res.status).toBe(200);
        expect((await s.cloud.storage.stat(KEY))?.sizeBytes).toBe(1024);
      } finally {
        await s.close();
      }
    });

    it("counts what arrives rather than trusting Content-Length", async () => {
      // The header is the caller's to write and a chunked request omits it
      // entirely, so a cap enforced from it is a cap a peer can opt out of.
      const s = await serveWithCap(1024);
      try {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            for (let i = 0; i < 8; i += 1) controller.enqueue(new Uint8Array(512));
            controller.close();
          },
        });
        const res = await fetch(`${s.url}/files/${encodeURIComponent(KEY)}`, {
          method: "PUT",
          body,
          // Chunked: undici sends no Content-Length for a stream body.
          duplex: "half",
        } as RequestInit & { duplex: "half" });
        expect(res.status).toBe(413);
        expect(await s.cloud.storage.has(KEY)).toBe(false);
      } finally {
        await s.close();
      }
    });
  });

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

  /**
   * The direct mirror of `exchange-request.test.ts`'s "watermark values that are
   * not positions" block, which had no counterpart on this side.
   *
   * Checking that `responderWatermarks` was an *object* and stopping there was
   * the expensive half-measure, because this is the direction where the value
   * survives the round: it is written to `syncState` wholesale and becomes the
   * bound on every future outbound scan. A junk value there does not fail — it
   * silently selects the wrong rows, forever, and the round that wrote it
   * reported `complete: true`.
   */
  describe("watermark values that are not positions", () => {
    const refuses = (watermarks: unknown) =>
      expect(
        respondingWith({ ...good, responderWatermarks: watermarks }).exchange({
          watermarks: {},
        }),
      ).rejects.toThrow(/responderWatermarks/);

    it("refuses a string where an HLC belongs", async () => {
      // The demonstrated case: feeding this to a real engine holding one
      // unshipped record produced `{"complete":true}` for a record that never
      // left, and persisted `{"L":"not-an-hlc"}` to disk.
      await refuses({ L: "not-an-hlc" });
    });

    it("refuses a negative wallTime", async () => {
      // `serializeHLC` renders it as a string that sorts below every stored row,
      // so `updated_at > since` selects the whole table — a full re-ship of the
      // library because a number arrived with a minus sign on it.
      await refuses({ L: { wallTime: -1, counter: 0, nodeId: "L" } });
    });

    it("refuses a fractional wallTime", async () => {
      await refuses({ L: { wallTime: 1.5, counter: 0, nodeId: "L" } });
    });

    it("refuses a fractional counter", async () => {
      await refuses({ L: { wallTime: 1, counter: 0.5, nodeId: "L" } });
    });

    it("refuses an entry with no nodeId", async () => {
      await refuses({ L: { wallTime: 1, counter: 0 } });
    });

    it("normalizes a nodeId that disagrees with its map key", async () => {
      // Rejecting would refuse a request whose intent is unambiguous. But the
      // pair cannot be left as it arrived: `planNodeScans` keys off the map key
      // while the serialized bound carries the value's `nodeId`, so a mismatch
      // shifts the tie-break at identical `(wallTime, counter)` — selecting or
      // skipping a row at exactly the boundary.
      const response = await respondingWith({
        ...good,
        responderWatermarks: { L: { wallTime: 5, counter: 1, nodeId: "someone-else" } },
      }).exchange({ watermarks: {} });
      expect(response.responderWatermarks["L"]).toEqual({
        wallTime: 5,
        counter: 1,
        nodeId: "L",
      });
    });
  });

  describe("the fields that decide whether a comparison happens at all", () => {
    it("refuses a digestScopes that is not an array of scope names", async () => {
      // A *string* was the dangerous shape: `sameScopes` compares `.length` and
      // then indexes, so a string of the right length survived the guard by
      // coincidence — two nodes agreeing they were comparing the same table set
      // on the strength of a typo.
      await expect(
        respondingWith({ ...good, digestScopes: "shared" }).exchange({ watermarks: {} }),
      ).rejects.toThrow(/digestScopes/);
      await expect(
        respondingWith({ ...good, digestScopes: [1] }).exchange({ watermarks: {} }),
      ).rejects.toThrow(/digestScopes/);
    });

    it("refuses a digestPrefixLength that is not a positive integer", async () => {
      await expect(
        respondingWith({ ...good, digestPrefixLength: "5" }).exchange({ watermarks: {} }),
      ).rejects.toThrow(/digestPrefixLength/);
      await expect(
        respondingWith({ ...good, digestPrefixLength: 0 }).exchange({ watermarks: {} }),
      ).rejects.toThrow(/digestPrefixLength/);
    });

    it("refuses a digest whose entries are not objects", async () => {
      await expect(
        respondingWith({ ...good, digest: ["nope"] }).exchange({ watermarks: {} }),
      ).rejects.toThrow(/digest/);
    });

    it("refuses a coverageComplete that is not a boolean", async () => {
      // The whole value of the field is that `false` changes how the coverage
      // map is merged, so a truthy string would silently take the `true` branch
      // — which is the branch that re-ships the library.
      await expect(
        respondingWith({ ...good, coverageComplete: "no" }).exchange({ watermarks: {} }),
      ).rejects.toThrow(/coverageComplete/);
    });

    it("carries a well-formed incomplete-coverage report through", async () => {
      const response = await respondingWith({
        ...good,
        coverageComplete: false,
        coverageDetail: "could not read coverage for: photos.captions",
      }).exchange({ watermarks: {} });
      expect(response.coverageComplete).toBe(false);
      expect(response.coverageDetail).toContain("photos.captions");
    });
  });

  it("refuses a records array holding something that is not a record", async () => {
    // Without this the round failed with a bare `TypeError` out of
    // `groupInboundByNodeId`, reading `.updatedAt` off a string — deep enough
    // that the stack said nothing about a peer having answered wrongly.
    await expect(
      respondingWith({ ...good, records: ["nope"] }).exchange({ watermarks: {} }),
    ).rejects.toThrow(/records\[0\]/);
    await expect(
      respondingWith({ ...good, labels: [null] }).exchange({ watermarks: {} }),
    ).rejects.toThrow(/labels\[0\]/);
  });
});
