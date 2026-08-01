/**
 * Variant resolution through a running local data server.
 *
 * The three layers — the resolution rules, the child-and-metadata gathering,
 * and the parameter parsing — are covered separately and their seams are typed.
 * What none of them proves is that a real
 * `GET /data/records?variant=…&variantLongEdge=…` comes back with a populated
 * `variants` map and usable URLs. That is what a consumer actually depends on,
 * and it is the layer where a wiring mistake (a param never read, a map never
 * attached, a URL never signed) passes every unit test.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startLocalDataServer, type LocalDataServer } from "@starkeep/testkit";
import {
  installApp,
  testAppManifest,
  createRecordWithBytes,
  type InstalledApp,
} from "./helpers.js";

/**
 * The test app's own label key, not Photos'.
 *
 * Deliberately a name of its own: variant resolution is generic over *a* label
 * key, and using `photos/rendition` here would let a platform that had quietly
 * hard-coded Photos' vocabulary still pass. `size-rung` is meaningless to the
 * server, which is the point.
 */
const RENDITION_KEY = "size-rung";
const RENDITION = `testapp/${RENDITION_KEY}`;

let server: LocalDataServer;
let app: InstalledApp;

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
            rationale: "test",
          },
        ],
        labelKeys: [{ key: RENDITION_KEY, description: "which derived size this record is" }],
      },
    }),
  );
}, 60_000);

afterAll(async () => {
  await server.stop();
});

/** A parent record plus derived children at the given long edges. */
async function seedLadder(
  longEdges: number[],
): Promise<{ parentId: string; byLongEdge: Map<number, string> }> {
  const { record: parent } = await createRecordWithBytes(app, {
    bytes: `original-${Math.random()}`,
    fileName: "original.jpg",
  });
  const byLongEdge = new Map<number, string>();
  for (const longEdge of longEdges) {
    const { record: child } = await createRecordWithBytes(app, {
      bytes: `rendition-${longEdge}-${Math.random()}`,
      fileName: `r${longEdge}.avif`,
      parentId: parent.id,
      // The class *value* is opaque to the server — it orders by dimensions,
      // not by name. Named here only because a rendition must carry the label
      // to be a candidate at all.
      labels: [{ key: RENDITION_KEY, value: `class-${longEdge}` }],
    });
    await app.fetch(`/data/records/${child.id}/metadata`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        typeId: "image",
        metadata: { width: longEdge, height: Math.round(longEdge * 0.75) },
      }),
    });
    byLongEdge.set(longEdge, child.id);
  }
  return { parentId: parent.id, byLongEdge };
}

async function listWithVariants(targets: number[]): Promise<
  Array<{ id: string; variants?: Record<string, { id: string; long_edge: number; url?: string }> }>
> {
  const res = await app.fetch(
    `/data/records?limit=100&notLabel=${encodeURIComponent(RENDITION)}` +
      `&variant=${encodeURIComponent(RENDITION)}&variantLongEdge=${targets.join(",")}`,
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { records: Array<never> };
  return body.records;
}

describe("variant resolution end to end", () => {
  it("returns a resolved variant per requested pixel size, with a URL", async () => {
    const { parentId, byLongEdge } = await seedLadder([400, 1280, 2560]);

    const records = await listWithVariants([400, 1280]);
    const parent = records.find((r) => r.id === parentId);
    expect(parent, "the original should be in the list").toBeTruthy();

    // Keyed by what was asked for, not by any class name.
    expect(Object.keys(parent!.variants ?? {}).sort()).toEqual(["1280", "400"]);
    expect(parent!.variants!["400"]!.id).toBe(byLongEdge.get(400));
    expect(parent!.variants!["1280"]!.id).toBe(byLongEdge.get(1280));
    // A URL rides the listing, so a grid needs no per-tile round trip.
    expect(typeof parent!.variants!["400"]!.url).toBe("string");
  });

  it("rounds up to the smallest rendition at or above the target", async () => {
    const { parentId, byLongEdge } = await seedLadder([400, 1280, 2560]);
    const records = await listWithVariants([500]);
    const parent = records.find((r) => r.id === parentId)!;
    // 500 px of viewport must not be served a 400 px image and upscaled.
    expect(parent.variants!["500"]!.id).toBe(byLongEdge.get(1280));
  });

  it("clamps to the largest rendition rather than reaching for the original", async () => {
    const { parentId, byLongEdge } = await seedLadder([400, 1280]);
    const records = await listWithVariants([99999]);
    const parent = records.find((r) => r.id === parentId)!;
    // Rule 3, observable from outside: exceeding the ladder resolves to the top
    // rung, never to the parent. Falling through to the original is what would
    // make a zoom request thaw an archived file.
    expect(parent.variants!["99999"]!.id).toBe(byLongEdge.get(1280));
    expect(parent.variants!["99999"]!.id).not.toBe(parentId);
  });

  it("excludes renditions from the listing itself", async () => {
    const { parentId, byLongEdge } = await seedLadder([400]);
    const records = await listWithVariants([400]);
    const ids = new Set(records.map((r) => r.id));
    expect(ids.has(parentId)).toBe(true);
    // Otherwise a 60k-item library is 300k+ records and the client cannot tell
    // how far to keep paging.
    expect(ids.has(byLongEdge.get(400)!)).toBe(false);
  });

  it("omits variants for a record that has none, rather than inventing one", async () => {
    const { record } = await createRecordWithBytes(app, {
      bytes: `lonely-${Math.random()}`,
      fileName: "no-renditions.jpg",
    });
    const records = await listWithVariants([400]);
    const found = records.find((r) => r.id === record.id)!;
    // An empty map and a missing rendition read the same way to a consumer:
    // show the inline placeholder.
    expect(Object.keys(found.variants ?? {})).toEqual([]);
  });

  it("does not attach variants when they were not asked for", async () => {
    await seedLadder([400]);
    const res = await app.fetch(`/data/records?limit=100`);
    const body = (await res.json()) as { records: Array<{ variants?: unknown }> };
    // The extra child query is not free, and every existing caller passes
    // neither parameter.
    for (const record of body.records) expect(record.variants).toBeUndefined();
  });
});
