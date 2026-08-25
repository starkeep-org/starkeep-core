/**
 * The unnarrowed variant list.
 *
 * `variant=<app>/<key>&variantLongEdge=…` answers "which derived child best
 * fits this many pixels", which is the right question for a client that just
 * wants an image. It is the wrong question for the app that owns the ladder,
 * because the answer throws away the two facts that app needs next: whether the
 * rung it did not get is missing or was never going to exist for this record,
 * and what smaller rung it could paint while the right one derives.
 *
 * So `variant` alone returns the whole set. What matters in these assertions is
 * that it stays app-agnostic — the server orders by long edge and names no
 * class — and that the two forms remain distinct answers rather than one
 * silently degrading into the other.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startLocalDataServer, type LocalDataServer } from "@starkeep/testkit";
import { installApp, testAppManifest, createRecordWithBytes, type InstalledApp } from "./helpers.js";

let server: LocalDataServer;
let app: InstalledApp;
let parentId: string;

const LABEL = "testapp/rendition";

interface Candidate {
  id: string;
  width: number;
  height: number;
  long_edge: number;
  label_value: string;
  available_here: boolean;
  url?: string;
}

async function addRendition(width: number, height: number, sizeClass: string): Promise<string> {
  const { record } = await createRecordWithBytes(app, {
    bytes: Buffer.from(`rendition-${sizeClass}`),
    fileName: `${sizeClass}.jpg`,
    parentId,
    labels: [{ key: "rendition", value: sizeClass }],
  });
  const res = await app.fetch(`/data/records/${record.id}/metadata`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ typeId: "image", metadata: { width, height } }),
  });
  expect(res.ok).toBe(true);
  return record.id;
}

const list = async (query: string) => {
  const res = await app.fetch(`/data/records?parentId=none&${query}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    records: Array<{ id: string; variant_candidates?: Candidate[]; variants?: Record<string, unknown> }>;
  };
  return body.records.find((r) => r.id === parentId)!;
};

beforeAll(async () => {
  server = await startLocalDataServer();
  app = await installApp(
    server,
    testAppManifest({
      infraRequirements: {
        fileAccess: [
          {
            types: ["image/jpeg", "image/png"],
            access: "readwrite",
            metadataWrite: true,
            rationale: "variant candidate test",
          },
        ],
        labelKeys: [{ key: "rendition", description: "A derived size" }],
      },
    }),
  );
  const { record } = await createRecordWithBytes(app, {
    bytes: Buffer.from("the original"),
    fileName: "original.jpg",
  });
  parentId = record.id;
  // Deliberately out of order, so an assertion on ordering is testing the
  // server rather than the insertion sequence.
  await addRendition(1280, 960, "medium");
  await addRendition(128, 96, "xsmall");
  await addRendition(400, 300, "thumb");
}, 60_000);

afterAll(async () => {
  await server.stop();
});

describe("asking for the whole set", () => {
  it("returns every derived child, ascending by long edge", async () => {
    const record = await list(`variant=${encodeURIComponent(LABEL)}`);
    expect(record.variant_candidates?.map((c) => c.long_edge)).toEqual([128, 400, 1280]);
  }, 30_000);

  it("carries dimensions and a URL for each, so the caller needs no second call", async () => {
    const record = await list(`variant=${encodeURIComponent(LABEL)}`);
    for (const candidate of record.variant_candidates ?? []) {
      expect(candidate.width).toBeGreaterThan(0);
      expect(candidate.height).toBeGreaterThan(0);
      expect(candidate.url).toBeTypeOf("string");
      expect(candidate.label_value).toBeTypeOf("string");
      expect(candidate.available_here).toBe(true);
    }
  }, 30_000);

  it("omits a child with no stored dimensions, which nothing could order", async () => {
    const { record: unmeasured } = await createRecordWithBytes(app, {
      bytes: Buffer.from("no dimensions written"),
      fileName: "unmeasured.jpg",
      parentId,
      labels: [{ key: "rendition", value: "screen" }],
    });
    const record = await list(`variant=${encodeURIComponent(LABEL)}`);
    expect(record.variant_candidates?.map((c) => c.id)).not.toContain(unmeasured.id);
  }, 30_000);
});

describe("the two forms stay distinct", () => {
  it("returns resolved variants, and no candidate list, when a size is named", async () => {
    const record = await list(`variant=${encodeURIComponent(LABEL)}&variantLongEdge=500`);
    expect(record.variants).toBeDefined();
    expect(record.variant_candidates).toBeUndefined();
    // Round-up resolution, unchanged: the smallest rung that reaches 500.
    expect(Object.values(record.variants!)).toHaveLength(1);
  }, 30_000);

  it("still rejects a pixel size with nothing to resolve it against", async () => {
    const res = await app.fetch(`/data/records?variantLongEdge=500`);
    expect(res.status).toBe(400);
  }, 30_000);
});
