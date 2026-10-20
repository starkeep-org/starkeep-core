/**
 * Rows ahead of files, across the wire: two real local-data-servers, the real
 * HTTP transport, and the fake cloud.
 *
 * The regression this pins is the one in
 * `findings-phone-to-desktop-sync-latency-2026-10-14.md`, problem 2: a row
 * could not leave a node until its file had reached the cloud, so another
 * device saw nothing while the upload was slow or failing. Here the cloud
 * refuses the upload for a while, and the other desktop must see the row
 * anyway — and the file must still arrive once uploads work again, because the
 * cloud's bytes watermark kept it owed.
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
let serverA: LocalDataServer;
let serverB: LocalDataServer;
let driveA: InstalledApp;
let driveB: InstalledApp;

interface SyncNowResult {
  applied: number;
  shipped: number;
  complete: boolean;
}

async function syncNow(app: InstalledApp): Promise<SyncNowResult> {
  const res = await app.fetch("/sync/now", { method: "POST" });
  expect(res.status).toBe(200);
  return (await res.json()) as SyncNowResult;
}

function cloudHasRow(id: string): boolean {
  return cloud.db.prepare(`SELECT 1 FROM shared_records WHERE id = ?`).get(id) !== undefined;
}

async function cloudHasFileFor(id: string): Promise<boolean> {
  const row = cloud.db
    .prepare(`SELECT object_storage_key AS k FROM shared_records WHERE id = ?`)
    .get(id) as { k: string } | undefined;
  return row !== undefined && (await cloud.hasBlob(row.k));
}

beforeAll(async () => {
  cloud = await startFakeCloud();
  const config = { apiGatewayUrl: cloud.url, pullIntervalMs: 600_000, pushDebounceMs: 50 };
  serverA = await startLocalDataServer({ config });
  serverB = await startLocalDataServer({ config });
  driveA = await builtinAppCreds(serverA, "starkeep-drive");
  driveB = await builtinAppCreds(serverB, "starkeep-drive");
}, 60_000);

afterAll(async () => {
  await serverA?.stop();
  await serverB?.stop();
  await cloud?.close();
});

describe("a row whose upload is failing", () => {
  it("reaches the other desktop anyway, and its file follows once uploads work", async () => {
    const { body } = await registerWithBytes(driveA, {
      type: "image/jpeg",
      contentType: "image/jpeg",
      fileName: "slow-upload.jpg",
    });
    const id = body.record!.id;

    // Every upload presign fails for a while.
    cloud.failures.blobPuts = 50;
    const pushed = await syncNow(driveA);
    expect(pushed.shipped).toBeGreaterThan(0);
    expect(pushed.complete).toBe(false);
    expect(cloudHasRow(id)).toBe(true);
    expect(await cloudHasFileFor(id)).toBe(false);

    // The other desktop sees the row now, not after the upload.
    await syncNow(driveB);
    const onB = await driveB.fetch(`/data/records/${id}`);
    expect(onB.status).toBe(200);

    // Uploads recover. The row is not shipped again, but the file is still
    // owed against the cloud's bytes watermark, so it goes.
    cloud.failures.blobPuts = 0;
    const recovered = await syncNow(driveA);
    expect(recovered.complete).toBe(true);
    expect(await cloudHasFileFor(id)).toBe(true);
  });
});
