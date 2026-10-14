/**
 * Inbound applies every row before it fetches any file.
 *
 * A round used to apply a row, download its file, and only then move to the
 * next row, with one change event after the last download. A desktop pulling a
 * phone's round therefore showed nothing until the round's largest video had
 * arrived. See `findings-phone-to-desktop-sync-latency-2026-10-14.md`,
 * problem 4.
 *
 * Rows and files now keep separate watermarks. The rows watermark passes every
 * row that applied; the bytes watermark stops at the first file, in HLC order,
 * that did not arrive.
 */

import { describe, it, expect } from "vitest";
import { createDataRecord, generateId, type StarkeepId } from "@starkeep/protocol-primitives";
import { createSyncEngine } from "../src/sync-engine.js";
import { createInProcessSyncTransport } from "../src/transports/in-process-transport.js";
import { buildSide } from "./sync-test-harness/side.js";
import { createMemorySyncStateStore } from "./sync-test-harness/memory-sync-state.js";
import type { ChangeEvent, ResidencyHooks, SyncStateStore } from "../src/types.js";
import type { BlobCandidate, ResidencyVerdict } from "../src/residency-policy.js";

type Side = Awaited<ReturnType<typeof buildSide>>;

const APP_ID = "photos";

async function twoSides() {
  let t = 0;
  const wallClock = () => t++;
  return {
    local: await buildSide({ role: "local", nodeId: "L", wallClock, appId: APP_ID }),
    cloud: await buildSide({ role: "cloud", nodeId: "C", wallClock, appId: APP_ID }),
  };
}

async function seedRecordWithBlob(side: Side, sizeBytes: number): Promise<StarkeepId> {
  const id = generateId() as StarkeepId;
  const key = `shared/test/photo/${id}`;
  await side.storage.put(key, new Uint8Array(sizeBytes).fill(7));
  await side.db.put({
    ...createDataRecord(
      {
        type: "image/jpeg",
        originAppId: APP_ID,
        contentHash: `sha256:${id}`,
        objectStorageKey: key,
        mimeType: "image/jpeg",
        sizeBytes,
      },
      side.clock,
    ),
    id,
  });
  return id;
}

function driveChannel(
  local: Side,
  cloud: Side,
  syncState: SyncStateStore,
  residency: ResidencyHooks,
  maxBytes?: number,
) {
  return createSyncEngine({
    localDatabaseAdapter: local.db,
    localObjectStorage: local.storage,
    remoteObjectStorage: cloud.storage,
    transport: createInProcessSyncTransport({
      databaseAdapter: cloud.db,
      clock: cloud.clock,
      objectStorage: cloud.storage,
      syncSharedRecords: true,
    }),
    clock: local.clock,
    syncState,
    syncSharedRecords: true,
    residency,
    ...(maxBytes !== undefined ? { maxBytes } : {}),
  });
}

/** Hooks that want every blob and report each decision to `onDecide`. */
function wantEverything(onDecide: (candidate: BlobCandidate) => void | Promise<void>): ResidencyHooks {
  return {
    decide: async (candidate): Promise<ResidencyVerdict> => {
      await onDecide(candidate);
      return { decision: "fetch", reason: "kept" };
    },
  };
}

describe("inbound applies rows before blobs", () => {
  it("announces every row in the round before the first blob is fetched", async () => {
    const { local, cloud } = await twoSides();
    const ids = [
      await seedRecordWithBlob(cloud, 4_000),
      await seedRecordWithBlob(cloud, 64),
      await seedRecordWithBlob(cloud, 512),
    ];

    const events: ChangeEvent[] = [];
    let announcedAtFirstFetch: string[] | null = null;
    let rowsAtFirstFetch: number | null = null;
    const engine = driveChannel(
      local,
      cloud,
      createMemorySyncStateStore(),
      wantEverything(async () => {
        if (announcedAtFirstFetch !== null) return;
        announcedAtFirstFetch = events.flatMap((e) => e.recordIds);
        rowsAtFirstFetch = (await Promise.all(ids.map((id) => local.db.get(id)))).filter(Boolean).length;
      }),
    );
    engine.changeNotifier.subscribe((event) => events.push(event));

    const result = await engine.exchange();

    expect(rowsAtFirstFetch).toBe(3);
    expect(new Set(announcedAtFirstFetch)).toEqual(new Set(ids));
    expect(result.applied).toBe(3);
    expect(result.landed).toBe(3);
    expect(result.landedBytes).toBe(4_000 + 64 + 512);
    // The bytes are announced too, once they are here.
    const announcedAfter = events.slice(1).flatMap((e) => e.recordIds);
    expect(new Set(announcedAfter)).toEqual(new Set(ids));
    for (const id of ids) {
      expect(await local.storage.has(`shared/test/photo/${id}`)).toBe(true);
    }
  });

  it("fetches small files behind a large one in the same round", async () => {
    const { local, cloud } = await twoSides();
    const large = await seedRecordWithBlob(cloud, 4_000);
    const small = await seedRecordWithBlob(cloud, 64);
    const medium = await seedRecordWithBlob(cloud, 512);

    // A budget smaller than the large file. The large file still goes — it is
    // the head, and the first head file always goes — and the opportunistic
    // allotment takes the smaller ones rather than leaving them for later.
    const engine = driveChannel(
      local,
      cloud,
      createMemorySyncStateStore(),
      wantEverything(() => {}),
      1_000,
    );
    const result = await engine.exchange();

    expect(result.landed).toBe(3);
    for (const id of [large, small, medium]) {
      expect(await local.storage.has(`shared/test/photo/${id}`)).toBe(true);
    }
  });

  it("passes every row with the rows watermark and stops the bytes watermark at the first failed file", async () => {
    const { local, cloud } = await twoSides();
    const first = await seedRecordWithBlob(cloud, 64);
    const failing = await seedRecordWithBlob(cloud, 32);
    const third = await seedRecordWithBlob(cloud, 16);

    const syncState = createMemorySyncStateStore();
    const engine = driveChannel(local, cloud, syncState, {
      decide: async (candidate): Promise<ResidencyVerdict> => {
        if (candidate.recordId === failing) throw new Error("[test] this blob will not come");
        return { decision: "fetch", reason: "kept" };
      },
    });

    const result = await engine.exchange();

    // Every row is in, and every file but one.
    expect(result.applied).toBe(3);
    expect(result.landed).toBe(2);
    expect(result.blocked).toBe(true);
    const firstRecord = await cloud.db.get(first);
    const thirdRecord = await cloud.db.get(third);
    // The rows watermark passes every row, so the cloud sends none of them
    // again.
    expect((await syncState.getWatermarks())["C"]).toEqual(thirdRecord!.updatedAt);
    // The third file landed, and it still does not move the bytes watermark:
    // the second is owed below it.
    expect((await syncState.getByteWatermarks())?.["C"]).toEqual(firstRecord!.updatedAt);
    expect(await local.storage.has(`shared/test/photo/${third}`)).toBe(true);
  });

  it("fetches a file owed from an earlier round without the cloud sending its row again", async () => {
    const { local, cloud } = await twoSides();
    const id = await seedRecordWithBlob(cloud, 64);
    let refuse = true;

    const syncState = createMemorySyncStateStore();
    const engine = driveChannel(local, cloud, syncState, {
      decide: async (): Promise<ResidencyVerdict> => {
        if (refuse) throw new Error("[test] not this round");
        return { decision: "fetch", reason: "kept" };
      },
    });

    const first = await engine.exchange();
    expect(first.applied).toBe(1);
    expect(first.landed).toBe(0);

    refuse = false;
    const second = await engine.exchange();
    // The row is not re-sent: the rows watermark already passed it.
    expect(second.applied).toBe(0);
    // The file still arrives, because the bytes watermark kept it owed.
    expect(second.landed).toBe(1);
    expect(await local.storage.has(`shared/test/photo/${id}`)).toBe(true);
    expect((await syncState.getByteWatermarks())?.["C"]).toEqual((await cloud.db.get(id))!.updatedAt);
  });
});
