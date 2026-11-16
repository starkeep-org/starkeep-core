/**
 * The client document fetch against a real socket: no redirect is followed,
 * an oversized body is cut off, and a slow server times out.
 *
 * The server is plain HTTP on loopback, which the real fetch refuses twice
 * over (not https, not a public address). The request seam swaps in
 * `http.request` aimed at the server, so these tests exercise the same
 * response handling with the guards that run before the connection removed.
 */
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchDocument, MAX_DOCUMENT_BYTES } from "../../src/oauth-clients.js";

let server: Server;
let port: number;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { Location: "/doc" });
      res.end();
    } else if (req.url === "/big") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("x".repeat(MAX_DOCUMENT_BYTES + 1));
    } else if (req.url === "/slow") {
      res.writeHead(200);
      res.write("{");
      // Never ends.
    } else {
      res.writeHead(200, { "Cache-Control": "max-age=900" });
      res.end('{"ok":true}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

function fetchPath(path: string, timeoutMs?: number) {
  return fetchDocument(new URL(`https://client.example${path}`), {
    request: (url, options) =>
      httpRequest({
        host: "127.0.0.1",
        port,
        path: url.pathname,
        method: options.method,
        headers: options.headers,
        agent: false,
      }),
    ...(timeoutMs ? { timeoutMs } : {}),
  });
}

describe("fetchDocument", () => {
  it("reads a document and its Cache-Control", async () => {
    expect(await fetchPath("/doc")).toEqual({
      status: 200,
      cacheControl: "max-age=900",
      body: '{"ok":true}',
    });
  });

  it("answers a redirect's status without following it", async () => {
    expect((await fetchPath("/redirect")).status).toBe(302);
  });

  it("refuses a body over the size cap", async () => {
    await expect(fetchPath("/big")).rejects.toThrow(/too large/);
  });

  it("gives up on a slow server", async () => {
    await expect(fetchPath("/slow", 200)).rejects.toThrow(/timed out/);
  });
});
