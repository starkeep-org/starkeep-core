/**
 * Batch file-url resolution: POST /data/records/file-urls returns per-id
 * time-limited URLs in one request, mirroring the single file-url route's
 * semantics per id. Unknown/unreadable ids are omitted (not errors), and the
 * returned URLs serve bytes without HMAC exactly like single-route tokens.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startLocalDataServer, type LocalDataServer } from "@starkeep/testkit";
import {
  installApp,
  testAppManifest,
  readOnlyAppManifest,
  createRecordWithBytes,
  type InstalledApp,
} from "./helpers.js";

let server: LocalDataServer;
let app: InstalledApp;

interface BatchResponse {
  urls: Record<string, { url: string; mimeType?: string | null; sizeBytes?: number | null }>;
  expiresIn: number;
}

function postBatch(caller: InstalledApp, body: unknown): Promise<Response> {
  return caller.fetch("/data/records/file-urls", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  server = await startLocalDataServer();
  app = await installApp(server, testAppManifest());
}, 60_000);

afterAll(async () => {
  await server.stop();
});

describe("POST /data/records/file-urls", () => {
  it("returns servable URLs for every known id and omits unknown ids", async () => {
    const bytesA = Buffer.from("batch-bytes-a");
    const bytesB = Buffer.from("batch-bytes-b");
    const { record: a } = await createRecordWithBytes(app, { bytes: bytesA, fileName: "a.jpg" });
    const { record: b } = await createRecordWithBytes(app, { bytes: bytesB, fileName: "b.jpg" });

    const res = await postBatch(app, { ids: [a.id, b.id, "not-a-real-id"] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as BatchResponse;

    expect(Object.keys(body.urls).sort()).toEqual([a.id, b.id].sort());
    expect(body.expiresIn).toBe(3600);
    expect(body.urls[a.id]).toMatchObject({ mimeType: "image/jpeg", sizeBytes: bytesA.length });

    // The URLs are the same token-gated kind the single route mints: plain
    // fetch, no HMAC, correct bytes.
    const servedA = await fetch(body.urls[a.id]!.url);
    expect(servedA.status).toBe(200);
    expect(Buffer.from(await servedA.arrayBuffer())).toEqual(bytesA);
    const servedB = await fetch(body.urls[b.id]!.url);
    expect(Buffer.from(await servedB.arrayBuffer())).toEqual(bytesB);
  });

  it("collapses duplicate ids into a single entry", async () => {
    const { record } = await createRecordWithBytes(app, { bytes: "dup-bytes", fileName: "dup.jpg" });
    const res = await postBatch(app, { ids: [record.id, record.id, record.id] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as BatchResponse;
    expect(Object.keys(body.urls)).toEqual([record.id]);
  });

  it("omits records whose type the caller cannot read", async () => {
    const readOnly = await installApp(server, readOnlyAppManifest());
    const { record } = await createRecordWithBytes(app, { bytes: "gated-bytes", fileName: "g.jpg" });

    // readonly-app has pdf-only grants; the image record must be invisible.
    const res = await postBatch(readOnly, { ids: [record.id] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as BatchResponse;
    expect(body.urls).toEqual({});
  });

  it("400s on a missing, empty, non-string, or oversized ids array", async () => {
    const cases: unknown[] = [
      {},
      { ids: [] },
      { ids: "r1" },
      { ids: [1, 2] },
      { ids: Array.from({ length: 501 }, (_, i) => `id-${i}`) },
    ];
    for (const body of cases) {
      const res = await postBatch(app, body);
      expect(res.status, JSON.stringify(body).slice(0, 60)).toBe(400);
    }
  });
});
