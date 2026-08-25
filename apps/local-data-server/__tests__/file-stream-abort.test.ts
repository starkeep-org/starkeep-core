/**
 * A client that hangs up mid-download must not take the server with it.
 *
 * This is the shape of the bug it guards: `pipeline` rejects with
 * ERR_STREAM_PREMATURE_CLOSE when the peer goes away, the rejection unwound to
 * the handler's outer catch, and that catch called `res.writeHead(500)` on a
 * response whose headers were long gone. The resulting ERR_HTTP_HEADERS_SENT
 * threw out of an async handler, which Node 24 treats as an unhandled rejection
 * and exits on — so scrolling a grid fast enough killed the process serving it.
 *
 * The assertion that matters is the last one: the server is still answering
 * afterwards. Asserting only that the aborted request failed would pass against
 * the broken server too, since it failed by dying.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startLocalDataServer, type LocalDataServer } from "@starkeep/testkit";
import { installApp, testAppManifest, createRecordWithBytes, type InstalledApp } from "./helpers.js";

let server: LocalDataServer;
let app: InstalledApp;
let fileUrl: string;

// Large enough that the response cannot land in a single chunk, so the abort
// genuinely arrives mid-body rather than after the whole thing is buffered.
const BODY = Buffer.alloc(8 * 1024 * 1024, "s");

beforeAll(async () => {
  server = await startLocalDataServer();
  app = await installApp(server, testAppManifest());
  const { record } = await createRecordWithBytes(app, {
    bytes: BODY,
    fileName: "big.jpg",
  });
  const res = await app.fetch(`/data/records/${record.id}/file-url`);
  fileUrl = ((await res.json()) as { url: string }).url;
}, 60_000);

afterAll(async () => {
  await server.stop();
});

describe("a client that hangs up mid-download", () => {
  it("leaves the server serving", async () => {
    const controller = new AbortController();
    const res = await fetch(fileUrl, { signal: controller.signal });
    expect(res.status).toBe(200);

    // Read one chunk and walk away, which is what a browser does when a tile
    // scrolls out of view.
    const reader = res.body!.getReader();
    await reader.read();
    controller.abort();
    await reader.cancel().catch(() => {});

    // The process is single-threaded and the abort is handled asynchronously,
    // so give it a turn to crash if it is going to.
    await new Promise((r) => setTimeout(r, 500));

    expect(server.child.exitCode).toBe(null);
    const health = await fetch(`${server.url}/health`);
    expect(health.ok).toBe(true);

    // And a full read still works, so the guard did not break the normal path.
    const whole = await fetch(fileUrl);
    expect(Buffer.from(await whole.arrayBuffer()).length).toBe(BODY.length);
  }, 30_000);
});
