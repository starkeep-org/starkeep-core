/**
 * Tests for GET /api/events — the same-origin SSE proxy to the local-data-
 * server's `/events` stream.
 *
 * This is the route whose behaviour is streaming plus abort propagation, and
 * both of those are mechanism rather than data: a proxy that buffers its
 * upstream instead of piping it turns every live update into a page that never
 * updates, and a proxy that drops the abort leaves an LDS subscriber per closed
 * browser tab. Neither failure changes a status code, so only a test that reads
 * the body incrementally and watches the upstream signal can see them.
 *
 * `fetch` is mocked; what is under test is the route, not the data server.
 */
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";

import { GET } from "../src/routes/events";

const realFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn() as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const mockFetch = () => globalThis.fetch as unknown as Mock;

/** A stream whose frames are pushed by the test, one at a time. */
function pushableStream(): {
  body: ReadableStream<Uint8Array>;
  push(text: string): void;
  close(): void;
} {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const encoder = new TextEncoder();
  return {
    body,
    push: (text: string) => controller.enqueue(encoder.encode(text)),
    close: () => controller.close(),
  };
}

/** Read exactly one chunk off a response body, decoded. */
async function readChunk(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  return new TextDecoder().decode(value);
}

function call(init?: RequestInit): Promise<Response> {
  return GET(new Request("http://drive.local/api/events", init));
}

describe("GET /api/events — the live path", () => {
  it("pipes upstream frames to the client as they arrive, not at the end", async () => {
    const upstream = pushableStream();
    mockFetch().mockResolvedValue(
      new Response(upstream.body, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );

    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("Cache-Control")).toBe("no-cache, no-transform");

    // The upstream is still open. A proxy that buffered would hang here; one
    // that pipes hands over each frame as it is pushed.
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    upstream.push("data: one\n\n");
    expect(decoder.decode((await reader.read()).value)).toBe("data: one\n\n");

    upstream.push("data: two\n\n");
    expect(decoder.decode((await reader.read()).value)).toBe("data: two\n\n");

    upstream.close();
    expect((await reader.read()).done).toBe(true);
  });

  it("asks the data server for an event stream and does not cache it", async () => {
    const upstream = pushableStream();
    mockFetch().mockResolvedValue(new Response(upstream.body, { status: 200 }));

    await call();

    const [url, init] = mockFetch().mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/events$/);
    expect((init.headers as Record<string, string>).Accept).toBe("text/event-stream");
    expect(init.cache).toBe("no-store");
    upstream.close();
  });
});

describe("GET /api/events — abort propagation", () => {
  it("forwards the client's abort signal upstream", async () => {
    const upstream = pushableStream();
    mockFetch().mockResolvedValue(new Response(upstream.body, { status: 200 }));

    const client = new AbortController();
    await call({ signal: client.signal });

    const init = mockFetch().mock.calls[0][1] as RequestInit;
    const forwarded = init.signal as AbortSignal;
    expect(forwarded).toBeInstanceOf(AbortSignal);
    expect(forwarded.aborted).toBe(false);

    // Closing the EventSource must tear the LDS connection down with it,
    // rather than leaving a subscriber per closed tab.
    client.abort();
    expect(forwarded.aborted).toBe(true);

    upstream.close();
  });
});

describe("GET /api/events — failure mapping", () => {
  it("answers an error frame with a 502 when the data server is unreachable", async () => {
    mockFetch().mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:9820"));

    const res = await call();

    expect(res.status).toBe(502);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    // An SSE frame rather than a bare body: the browser's EventSource is the
    // only reader, and it can only see this as an event.
    expect(await readChunk(res)).toBe(
      'event: error\ndata: "connect ECONNREFUSED 127.0.0.1:9820"\n\n',
    );
  });

  it("answers an error frame with a 502 when the data server refuses", async () => {
    mockFetch().mockResolvedValue(new Response("nope", { status: 503 }));

    const res = await call();

    expect(res.status).toBe(502);
    expect(await readChunk(res)).toBe(
      'event: error\ndata: "local-data-server /events unavailable (503)"\n\n',
    );
  });

  it("answers an error frame when the upstream is ok but carries no body", async () => {
    mockFetch().mockResolvedValue(new Response(null, { status: 204 }));

    const res = await call();

    expect(res.status).toBe(502);
    expect(await readChunk(res)).toContain("event: error");
  });
});
