/**
 * The wire, on its own.
 *
 * Every other transport test runs in-process, where a request is an object
 * handed to a function and nothing is ever serialized. This is the one place a
 * round trip is JSON, and the things that survive JSON badly are exactly the
 * things this protocol is made of: HLC timestamps (nested objects that must
 * come back with `wallTime`, `counter` and `nodeId` intact, since every LWW
 * comparison reads all three) and the `undefined`-vs-absent distinction that
 * separates "no digest performed" from "no divergence".
 *
 * It had been covered only incidentally, by the local-data-server's
 * over-the-wire e2e — which is a slow way to find out that a field did not
 * survive `JSON.stringify`.
 */

import { describe, it, expect } from "vitest";
import { createHttpSyncTransport } from "../src/transports/http-transport.js";
import { createHttpSyncHandler } from "../src/transports/http-server.js";
import { createInProcessSyncTransport } from "../src/transports/in-process-transport.js";
import { SyncError } from "../src/errors.js";
import { buildSide } from "./sync-test-harness/side.js";
import { createDataRecord, generateId, type StarkeepId } from "@starkeep/protocol-primitives";
import type { SyncExchangeRequest, SyncExchangeResponse } from "../src/types.js";

const hlc = { wallTime: 1_700_000_000_000, counter: 3, nodeId: "L" };

/** A `fetch` that records what it was given and answers with `body`. */
function stubFetch(body: unknown, init: { status?: number; text?: string } = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string, requestInit: RequestInit) => {
    calls.push({ url, init: requestInit });
    const status = init.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? "OK" : "Boom",
      json: async () => JSON.parse(JSON.stringify(body)),
      text: async () => init.text ?? "",
    };
  }) as unknown as typeof globalThis.fetch;
  return { calls, impl };
}

const emptyResponse: SyncExchangeResponse = {
  records: [],
  labels: [],
  appSyncableRows: [],
  responderWatermarks: {},
  hasMore: false,
};

describe("the request that goes out", () => {
  it("posts to /sync/exchange under the base URL", async () => {
    const fetchStub = stubFetch(emptyResponse);
    const transport = createHttpSyncTransport({
      baseUrl: "https://cloud.example/apps/photos",
      fetch: fetchStub.impl,
    });
    await transport.exchange({ watermarks: {} });

    expect(fetchStub.calls[0]!.url).toBe(
      "https://cloud.example/apps/photos/sync/exchange",
    );
    expect(fetchStub.calls[0]!.init.method).toBe("POST");
  });

  it("does not double the slash when the base URL has a trailing one", async () => {
    const fetchStub = stubFetch(emptyResponse);
    await createHttpSyncTransport({
      baseUrl: "https://cloud.example/apps/photos//",
      fetch: fetchStub.impl,
    }).exchange({ watermarks: {} });

    expect(fetchStub.calls[0]!.url).toBe(
      "https://cloud.example/apps/photos/sync/exchange",
    );
  });

  it("signs over the exact bytes it sends", async () => {
    // The signature is bound to method, path and body, so signing anything
    // other than the serialized body is a 401 the moment the real verifier
    // sees it.
    const fetchStub = stubFetch(emptyResponse);
    let signedBody: string | null = null;
    const transport = createHttpSyncTransport({
      baseUrl: "https://cloud.example",
      fetch: fetchStub.impl,
      signRequest: (method, path, body) => {
        signedBody = body;
        return { "X-Starkeep-App-Sig": `${method} ${path} ${body.length}` };
      },
    });
    await transport.exchange({ watermarks: { L: hlc }, limit: 7 });

    const sent = fetchStub.calls[0]!.init;
    expect(signedBody).toBe(sent.body);
    expect((sent.headers as Record<string, string>)["X-Starkeep-App-Sig"]).toBe(
      `POST /sync/exchange ${(sent.body as string).length}`,
    );
    expect((sent.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
  });

  it("carries an HLC watermark through as an object, not a string", async () => {
    const fetchStub = stubFetch(emptyResponse);
    await createHttpSyncTransport({
      baseUrl: "https://cloud.example",
      fetch: fetchStub.impl,
    }).exchange({ watermarks: { L: hlc } });

    const sent = JSON.parse(fetchStub.calls[0]!.init.body as string) as SyncExchangeRequest;
    expect(sent.watermarks["L"]).toEqual(hlc);
  });

  it("turns a non-2xx into a SyncError carrying the server's words", async () => {
    // A round that fails must fail loudly here: the engine treats a rejected
    // exchange as "nothing happened" and holds every watermark, which is only
    // safe because this does not quietly return an empty response.
    const fetchStub = stubFetch(null, { status: 500, text: "boom" });
    await expect(
      createHttpSyncTransport({
        baseUrl: "https://cloud.example",
        fetch: fetchStub.impl,
      }).exchange({ watermarks: {} }),
    ).rejects.toThrow(SyncError);
  });
});

describe("a real round trip over HTTP", () => {
  /** Wire the client transport straight into the server handler, over JSON. */
  async function connected() {
    let t = 0;
    const wallClock = () => t++;
    const local = await buildSide({ role: "local", nodeId: "L", wallClock, appId: "photos" });
    const cloud = await buildSide({ role: "cloud", nodeId: "C", wallClock, appId: "photos" });
    const handler = createHttpSyncHandler({
      databaseAdapter: cloud.db,
      objectStorageAdapter: cloud.storage,
      clock: cloud.clock,
      transport: createInProcessSyncTransport({
        databaseAdapter: cloud.db,
        clock: cloud.clock,
        objectStorage: cloud.storage,
        syncSharedRecords: true,
      }),
    });

    // The narrowest thing that is still a round trip: serialize, hand the
    // bytes to the handler, deserialize what it wrote.
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const body = init.body as string;
      let status = 200;
      let payload = "";
      const req = {
        method: "POST",
        url: new URL(url).pathname,
        headers: { host: "cloud.example" },
        on(event: string, cb: (chunk?: Buffer) => void) {
          if (event === "data") cb(Buffer.from(body));
          if (event === "end") cb();
          return this;
        },
      };
      const res = {
        writeHead(code: number) {
          status = code;
          return this;
        },
        end(chunk?: string) {
          payload = chunk ?? "";
        },
      };
      await handler(req as never, res as never);
      return {
        ok: status >= 200 && status < 300,
        status,
        statusText: "OK",
        json: async () => JSON.parse(payload),
        text: async () => payload,
      };
    }) as unknown as typeof globalThis.fetch;

    return {
      local,
      cloud,
      transport: createHttpSyncTransport({ baseUrl: "http://cloud.example", fetch: fetchImpl }),
    };
  }

  async function seedRecord(side: Awaited<ReturnType<typeof buildSide>>): Promise<StarkeepId> {
    const id = generateId() as StarkeepId;
    await side.db.put({
      ...createDataRecord(
        {
          type: "@test/note",
          originAppId: "photos",
          contentHash: `sha256:${id}`,
          objectStorageKey: "",
          mimeType: "application/octet-stream",
          sizeBytes: 0,
        },
        side.clock,
      ),
      id,
    });
    return id;
  }

  it("brings a record back with its HLCs intact", async () => {
    const { cloud, transport } = await connected();
    const id = await seedRecord(cloud);

    const response = await transport.exchange({ watermarks: {} });

    const record = response.records.find((r) => r.id === id)!;
    expect(record).toBeDefined();
    // Every LWW comparison in the system reads all three fields; a serializer
    // that dropped `counter` would produce a comparison that is right most of
    // the time.
    const stored = (await cloud.db.get(id))!;
    expect(record.updatedAt).toEqual(stored.updatedAt);
    expect(record.createdAt).toEqual(stored.createdAt);
    expect(response.responderWatermarks["C"]).toEqual(stored.updatedAt);
  });

  it("distinguishes 'no digest performed' from 'no divergence'", async () => {
    // `undefined` does not survive JSON — it comes back as an absent key, and
    // that is exactly the intended reading. What must not happen is the field
    // arriving as `null` or `[]`, either of which the requester would take as
    // a real answer meaning "we agree".
    const { transport } = await connected();

    const quiet = await transport.exchange({ watermarks: {} });
    expect("digest" in quiet).toBe(false);

    const asked = await transport.exchange({
      watermarks: {},
      limit: 0,
      requestDigest: true,
      digestPrefixLength: 5,
    });
    expect(asked.digest).toEqual([]);
    expect(asked.digestPrefixLength).toBe(5);
  });

  it("refuses a body the responder cannot read, without reaching the store", async () => {
    const { transport } = await connected();
    await expect(
      transport.exchange({ watermarks: { L: "5:0:L" } } as unknown as SyncExchangeRequest),
    ).rejects.toThrow(/400/);
  });
});
