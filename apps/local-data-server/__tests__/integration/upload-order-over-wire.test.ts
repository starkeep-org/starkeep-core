/**
 * The upload order, across the wire: a real local-data-server, its uploader,
 * the real HTTP adapter's batch presign, and the fake cloud.
 *
 * Another node's photo list paints from stand-ins, so a desktop sends them
 * before the originals they stand in for, with the same tiers a phone uses.
 * See `design-upload-queue-2026-10-23.md`, decision 4.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  startLocalDataServer,
  startFakeCloud,
  type LocalDataServer,
  type FakeCloud,
} from "@starkeep/testkit";
import { builtinAppCreds, registerWithBytes, type InstalledApp } from "../helpers.js";

let cloud: FakeCloud;
let server: LocalDataServer;
let drive: InstalledApp;

beforeAll(async () => {
  cloud = await startFakeCloud();
  server = await startLocalDataServer({
    config: { apiGatewayUrl: cloud.url, pullIntervalMs: 600_000, pushDebounceMs: 50 },
  });
  drive = await builtinAppCreds(server, "starkeep-drive");
}, 60_000);

afterAll(async () => {
  await server?.stop();
  await cloud?.close();
});

/** The record's object key, as the cloud stored the row. */
async function keyOf(id: string): Promise<string> {
  const row = cloud.db
    .prepare(`SELECT object_storage_key AS k FROM shared_records WHERE id = ?`)
    .get(id) as { k: string } | undefined;
  return row!.k;
}

describe("a desktop's uploads", () => {
  it("send the stand-ins before the originals they stand in for", async () => {
    // Paused, so everything exists before the uploader looks: the order is
    // then the scheduler's, not the order the files were written in.
    expect((await drive.fetch("/sync/pause", { method: "POST" })).status).toBe(200);
    const originals: string[] = [];
    const standIns: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const original = await registerWithBytes(drive, {
        type: "image/jpeg",
        contentType: "image/jpeg",
        fileName: `photo-${i}.jpg`,
        sizeBytes: 3 * 1024 * 1024,
      });
      originals.push(original.body.record!.id);
      const standIn = await registerWithBytes(drive, {
        type: "image/avif",
        contentType: "image/avif",
        parentId: original.body.record!.id,
        sizeBytes: 60_000,
      });
      expect(standIn.status, JSON.stringify(standIn.body)).toBeLessThan(300);
      standIns.push(standIn.body.record!.id);
    }
    cloud.blobPutLog.length = 0;

    expect((await drive.fetch("/sync/resume", { method: "POST" })).status).toBe(200);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const res = await drive.fetch("/sync/now", { method: "POST" });
      if (((await res.json()) as { complete: boolean }).complete) break;
    }

    const order = await Promise.all([...standIns, ...originals].map(keyOf));
    for (const key of order) expect(await cloud.hasBlob(key), key).toBe(true);
    const position = (key: string) => cloud.blobPutLog.indexOf(key);
    const lastStandIn = Math.max(...order.slice(0, 2).map(position));
    const firstOriginal = Math.min(...order.slice(2).map(position));
    expect(lastStandIn).toBeLessThan(firstOriginal);
  }, 30_000);
});
