/**
 * Stand-ins across the wire: two real local-data-servers and the fake cloud.
 *
 * Pins the two things only a full round trip shows: the role and the fidelity
 * survive the exchange as columns, and two stand-ins for one slot made while
 * both nodes were cut off from the cloud converge on one — the cloud's first —
 * without stopping sync.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  startLocalDataServer,
  startFakeCloud,
  fakeIdToken,
  type LocalDataServer,
  type FakeCloud,
} from "@starkeep/testkit";
import { builtinAppCreds, registerWithBytes, type InstalledApp } from "./helpers.js";

const BIG = 2 * 1024 * 1024;

let cloud: FakeCloud;
let serverA: LocalDataServer;
let serverB: LocalDataServer;
let driveA: InstalledApp;
let driveB: InstalledApp;

async function syncNow(app: InstalledApp): Promise<{ applied: number; shipped: number }> {
  const res = await app.fetch("/sync/now", { method: "POST" });
  expect(res.status).toBe(200);
  return (await res.json()) as { applied: number; shipped: number };
}

/** Two consecutive quiet rounds; see `sync-over-wire.test.ts` for why two. */
async function converge(maxRounds = 30): Promise<void> {
  let quiet = 0;
  for (let i = 0; i < maxRounds; i++) {
    const a = await syncNow(driveA);
    const b = await syncNow(driveB);
    if (a.applied === 0 && a.shipped === 0 && b.applied === 0 && b.shipped === 0) {
      quiet += 1;
      if (quiet >= 2) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    } else {
      quiet = 0;
    }
  }
  throw new Error(`did not converge within ${maxRounds} rounds`);
}

beforeAll(async () => {
  cloud = await startFakeCloud();
  const config = { apiGatewayUrl: cloud.url, pullIntervalMs: 600_000, pushDebounceMs: 50, syncMaxItems: 5 };
  serverA = await startLocalDataServer({ config, auth: { idToken: fakeIdToken() } });
  serverB = await startLocalDataServer({ config, auth: { idToken: fakeIdToken() } });
  driveA = await builtinAppCreds(serverA, "starkeep-drive");
  driveB = await builtinAppCreds(serverB, "starkeep-drive");
}, 60_000);

afterAll(async () => {
  await serverA?.stop();
  await serverB?.stop();
  await cloud?.close();
});

async function record(app: InstalledApp, id: string): Promise<Record<string, unknown> | null> {
  const res = await app.fetch(`/data/records/${id}`);
  if (res.status === 404) return null;
  return ((await res.json()) as { record: Record<string, unknown> }).record;
}

async function standInsOf(app: InstalledApp, parentId: string): Promise<Array<Record<string, unknown>>> {
  const where = encodeURIComponent(JSON.stringify({ parent_id: parentId }));
  const res = await app.fetch(`/data/records?where=${where}&include=stand-ins`);
  return ((await res.json()) as { records: Array<Record<string, unknown>> }).records;
}

function cloudLiveCanonicals(parentId: string): string[] {
  return (
    cloud.db
      .prepare(
        "SELECT id FROM shared_records WHERE parent_id = ? AND stand_in_role = 'canonical' AND deleted_at IS NULL",
      )
      .all(parentId) as Array<{ id: string }>
  ).map((r) => r.id);
}

describe("stand-ins across the wire", () => {
  it("carry their role and fidelity, and the original's reported fidelity, to the other node", async () => {
    const original = await registerWithBytes(driveA, {
      type: "image/jpeg",
      sizeBytes: BIG,
      fileName: "wire-original.jpg",
    });
    const parentId = original.body.record!.id;
    const small = await registerWithBytes(driveA, {
      type: "image/avif",
      contentType: "image/avif",
      parentId,
      fileName: "wire-640",
      standIn: { role: "smaller", fidelity: 640 },
      parentFidelity: 6000,
    });
    expect(small.status).toBe(200);
    await converge();

    expect(await record(driveB, parentId)).toMatchObject({ fidelity: 6000, stand_in_role: null });
    expect(await record(driveB, small.body.record!.id)).toMatchObject({
      stand_in_role: "smaller",
      fidelity: 640,
      parent_id: parentId,
    });
  });

  it("converge on the cloud's first canonical stand-in when two nodes made one offline", async () => {
    const original = await registerWithBytes(driveA, {
      type: "image/jpeg",
      sizeBytes: BIG,
      fileName: "race-original.jpg",
      fidelity: 6000,
    });
    const parentId = original.body.record!.id;
    await converge();
    expect(await record(driveB, parentId)).not.toBeNull();

    // Both nodes cut off: each makes its own canonical stand-in.
    cloud.failures.allExchanges = true;
    try {
      const [fromA, fromB] = await Promise.all([
        registerWithBytes(driveA, {
          type: "image/avif",
          contentType: "image/avif",
          parentId,
          bytes: "encoder A",
          fileName: "canonical-a",
          standIn: { role: "canonical", fidelity: 4272 },
        }),
        registerWithBytes(driveB, {
          type: "image/avif",
          contentType: "image/avif",
          parentId,
          bytes: "encoder B",
          fileName: "canonical-b",
          standIn: { role: "canonical", fidelity: 4272 },
        }),
      ]);
      expect(fromA.status).toBe(200);
      expect(fromB.status).toBe(200);
    } finally {
      cloud.failures.allExchanges = false;
    }

    await converge();

    const winners = cloudLiveCanonicals(parentId);
    expect(winners).toHaveLength(1);
    for (const app of [driveA, driveB]) {
      const live = (await standInsOf(app, parentId)).filter((r) => r.stand_in_role === "canonical");
      expect(live.map((r) => r.id)).toEqual(winners);
    }
  });
});
