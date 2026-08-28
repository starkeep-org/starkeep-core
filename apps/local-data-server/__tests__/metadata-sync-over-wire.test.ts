/**
 * Per-category metadata reaching a second node, end to end.
 *
 * Two real local-data-server processes exchanging through one fake cloud over
 * HTTP, with real SQLite on all three. The engine suite proves the merge rules;
 * what this proves is that they survive the whole stack — the HTTP transport,
 * the request sanitizer that passes record elements through unvalidated, the
 * row whitelist on the far side, and the clock bump that is the only thing
 * making a later metadata write visible to a sync scan at all.
 *
 * The failure being fixed is specific: Photos registers a rendition, then
 * writes its dimensions in a second call, and any round landing between the two
 * shipped the record forever without them. The cloud then dropped the
 * dimensionless candidate and reported the original as having no renditions,
 * which is indistinguishable from "nothing derived yet".
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  startLocalDataServer,
  startFakeCloud,
  fakeIdToken,
  type LocalDataServer,
  type FakeCloud,
} from "@starkeep/testkit";
import {
  builtinAppCreds,
  createRecordWithBytes,
  installApp,
  testAppManifest,
  type InstalledApp,
} from "./helpers.js";

let cloud: FakeCloud;
let serverA: LocalDataServer;
let serverB: LocalDataServer;
let driveA: InstalledApp;
let driveB: InstalledApp;
/** A metadataWrite-granted app on A — the Drive identity holds no decoder. */
let photosA: InstalledApp;

function serverConfig(cloudUrl: string) {
  return { apiGatewayUrl: cloudUrl, pullIntervalMs: 600_000, pushDebounceMs: 50 };
}

async function syncNow(app: InstalledApp): Promise<{ applied: number; shipped: number }> {
  const res = await app.fetch("/sync/now", { method: "POST" });
  expect(res.status).toBe(200);
  return (await res.json()) as { applied: number; shipped: number };
}

/** Drive both servers until two consecutive rounds move nothing. */
async function converge(maxRounds = 30): Promise<void> {
  let quiet = 0;
  for (let i = 0; i < maxRounds; i++) {
    const a = await syncNow(driveA);
    const b = await syncNow(driveB);
    if (a.applied || a.shipped || b.applied || b.shipped) {
      quiet = 0;
      continue;
    }
    quiet += 1;
    if (quiet >= 2) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`did not converge within ${maxRounds} rounds`);
}

/** The cloud's own metadata row, read straight out of its database. */
function cloudMetadata(recordId: string): Record<string, unknown> | null {
  const rows = cloud.db
    .prepare(`SELECT * FROM shared_record_image_metadata WHERE record_id = ?`)
    .all(recordId) as Record<string, unknown>[];
  return rows[0] ?? null;
}

async function metadataOn(
  app: InstalledApp,
  recordId: string,
): Promise<Record<string, unknown> | null> {
  const res = await app.fetch(`/data/records/${recordId}/metadata/image`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { metadata: Record<string, unknown> | null }).metadata;
}

beforeAll(async () => {
  cloud = await startFakeCloud();
  serverA = await startLocalDataServer({
    config: serverConfig(cloud.url),
    auth: { idToken: fakeIdToken() },
  });
  serverB = await startLocalDataServer({
    config: serverConfig(cloud.url),
    auth: { idToken: fakeIdToken() },
  });
  driveA = await builtinAppCreds(serverA, "starkeep-drive");
  driveB = await builtinAppCreds(serverB, "starkeep-drive");
  photosA = await installApp(serverA, testAppManifest());
}, 60_000);

afterAll(async () => {
  await serverA?.stop();
  await serverB?.stop();
  await cloud?.close();
});

describe("metadata across the wire", () => {
  it(
    "carries metadata written at create through to the cloud and the second node",
    { timeout: 30_000 },
    async () => {
      const { record } = await createRecordWithBytes(photosA, {
        bytes: "wire-metadata-inline",
        fileName: "inline.jpg",
        metadata: { width: 4032, height: 3024 },
      });
      await converge();

      expect(cloudMetadata(record.id)).toMatchObject({ width: 4032, height: 3024 });
      expect(await metadataOn(driveB, record.id)).toMatchObject({
        width: 4032,
        height: 3024,
      });
    },
  );

  it(
    "carries metadata written after the record already synced",
    { timeout: 30_000 },
    async () => {
      const { record } = await createRecordWithBytes(photosA, {
        bytes: "wire-metadata-later",
        fileName: "later.jpg",
      });
      // The record crosses first, with no metadata — exactly the interleaving
      // that used to strand a rendition in the cloud without its dimensions.
      await converge();
      expect(cloudMetadata(record.id)).toBeNull();

      const write = await photosA.fetch(`/data/records/${record.id}/metadata`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ typeId: "image/jpeg", metadata: { width: 1280, height: 960 } }),
      });
      expect(write.status).toBe(200);

      await converge();

      // The clock bump on the metadata write is the only reason this round
      // selects the record at all.
      expect(cloudMetadata(record.id)).toMatchObject({ width: 1280, height: 960 });
      expect(await metadataOn(driveB, record.id)).toMatchObject({ width: 1280 });
    },
  );

  it(
    "leaves columns a peer holds and this node does not",
    { timeout: 30_000 },
    async () => {
      const { record } = await createRecordWithBytes(photosA, {
        bytes: "wire-metadata-partial",
        fileName: "partial.jpg",
        metadata: { width: 800, height: 600 },
      });
      await converge();

      // A second, narrower write naming only the ThumbHash. Null columns never
      // go on the wire, so this cannot erase the dimensions anywhere.
      const write = await photosA.fetch(`/data/records/${record.id}/metadata`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ typeId: "image/jpeg", metadata: { thumb_hash: "TH" } }),
      });
      expect(write.status).toBe(200);
      await converge();

      expect(cloudMetadata(record.id)).toMatchObject({
        width: 800,
        height: 600,
        thumb_hash: "TH",
      });
    },
  );

  it(
    "re-writing metadata recovers a record the cloud already holds without it",
    { timeout: 30_000 },
    async () => {
      const { record } = await createRecordWithBytes(photosA, {
        bytes: "wire-metadata-touch",
        fileName: "touch.jpg",
        metadata: { width: 2000, height: 1500 },
      });
      await converge();
      expect(cloudMetadata(record.id)).not.toBeNull();

      // Stand in for an install that synced before metadata rode the wire: the
      // cloud holds the record at the same `updated_at` as A and no metadata
      // row, so no ordinary round will ever select it again.
      cloud.db.prepare(`DELETE FROM shared_record_image_metadata WHERE record_id = ?`).run(
        record.id,
      );
      expect(cloudMetadata(record.id)).toBeNull();
      await converge();
      expect(cloudMetadata(record.id)).toBeNull();

      // The migration, and it is just an ordinary metadata write of the values
      // this node already holds. The clock bump moves the record above the
      // peer's watermark, so the next delta scan selects it and carries the row
      // along. No protocol lever, no floor, and safe to repeat.
      const local = await metadataOn(photosA, record.id);
      const touch = await photosA.fetch(`/data/records/${record.id}/metadata`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          typeId: "image/jpeg",
          metadata: { width: local!.width, height: local!.height },
        }),
      });
      expect(touch.status).toBe(200);

      await converge();

      expect(cloudMetadata(record.id)).toMatchObject({ width: 2000, height: 1500 });
    },
  );
});
