/**
 * The derived-children list: `variant=<app>/<key>`.
 *
 * Returns every live child carrying the label, with its dimensions, and lets
 * the app that owns the label choose. What matters in these assertions is that
 * it stays app-agnostic — the server orders by long edge and names no class.
 * Choosing a size of the original is a content read at a size, not this.
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
  const res = await app.fetch(
    `/data/records?where=${encodeURIComponent(JSON.stringify({ parent_id: null }))}&${query}`,
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    records: Array<{ id: string; variant_candidates?: Candidate[] }>;
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
      expect((candidate as unknown as { url_lifetime: { kind: string; expires_at: string } }).url_lifetime)
        .toMatchObject({ kind: "expires" });
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

describe("choosing a size", () => {
  it("is not a parameter of the listing any more", async () => {
    // A size of the original is `GET /data/records/:id/content-url?size=`,
    // answered from its stand-ins.
    const res = await app.fetch(`/data/records?variant=${encodeURIComponent(LABEL)}&variantLongEdge=500`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/"variantLongEdge" is not a parameter/);
  }, 30_000);
});
