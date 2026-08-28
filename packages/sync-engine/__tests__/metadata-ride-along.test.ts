/**
 * Per-category metadata crossing a sync boundary.
 *
 * The metadata row rides the record it belongs to rather than becoming its own
 * synced entity — no clock, no watermark, no stream. What that buys and why it
 * is sound is argued in `metadata-sync.ts`; what it costs is tested here.
 *
 * Two behaviours carry the whole design and each has its own case below:
 *
 *   - **The merge overwrites the columns a snapshot names and only those.**
 *     Null columns are stripped before sending, so absence on the wire means
 *     "no information" and a node that knows only a ThumbHash cannot erase a
 *     peer's dimensions.
 *   - **Applying metadata sits outside the record's LWW guard.** An equal or
 *     older record row can still carry columns the receiver lacks, and while
 *     peers converge onto this wire format that is the common case.
 */

import { describe, it, expect } from "vitest";
import {
  createDataRecord,
  createHLCClock,
  type DataRecord,
  type HLCClock,
  type MetadataRow,
  type StarkeepId,
} from "@starkeep/protocol-primitives";
import {
  MockDatabaseAdapter,
  MockObjectStorageAdapter,
} from "@starkeep/storage-adapter";
import { createSyncEngine } from "../src/sync-engine.js";
import { createInProcessSyncTransport } from "../src/transports/in-process-transport.js";
import type { SyncEngine, SyncTransport } from "../src/types.js";
import { createMemorySyncStateStore } from "./sync-test-harness/memory-sync-state.js";

interface Pair {
  readonly local: MockDatabaseAdapter;
  readonly cloud: MockDatabaseAdapter;
  readonly localStorage: MockObjectStorageAdapter;
  readonly cloudStorage: MockObjectStorageAdapter;
  readonly localClock: HLCClock;
  readonly cloudClock: HLCClock;
  readonly transport: SyncTransport;
  readonly engine: SyncEngine;
}

async function makePair(): Promise<Pair> {
  let time = 1000;
  const localClock = createHLCClock({ nodeId: "local", wallClockFunction: () => time++ });
  const cloudClock = createHLCClock({ nodeId: "cloud", wallClockFunction: () => time++ });

  const local = new MockDatabaseAdapter();
  const cloud = new MockDatabaseAdapter();
  const localStorage = new MockObjectStorageAdapter();
  const cloudStorage = new MockObjectStorageAdapter();
  await local.init();
  await cloud.init();
  await localStorage.init();
  await cloudStorage.init();

  const transport = createInProcessSyncTransport({
    databaseAdapter: cloud,
    clock: cloudClock,
    objectStorage: cloudStorage,
  });
  const engine = createSyncEngine({
    localDatabaseAdapter: local,
    localObjectStorage: localStorage,
    remoteObjectStorage: cloudStorage,
    transport,
    clock: localClock,
    syncState: createMemorySyncStateStore(),
  });

  return { local, cloud, localStorage, cloudStorage, localClock, cloudClock, transport, engine };
}

/** A photo with its bytes present, written straight to one side's adapter. */
async function seedPhoto(
  db: MockDatabaseAdapter,
  storage: MockObjectStorageAdapter,
  clock: HLCClock,
  hash = "abc",
): Promise<DataRecord> {
  const record = createDataRecord(
    {
      type: "image/jpeg",
      originAppId: "photos",
      contentHash: hash,
      objectStorageKey: `shared/image/${hash.slice(0, 2)}/${hash}`,
      mimeType: "image/jpeg",
      sizeBytes: 3,
    },
    clock,
  );
  await db.put(record);
  await storage.put(record.objectStorageKey, new Uint8Array([1, 2, 3]), {
    contentType: "image/jpeg",
  });
  return record;
}

/**
 * What both `POST /data/records/:id/metadata` routes do: write the columns,
 * then move the record's clock so the outbound delta scan selects it again.
 *
 * Written out here rather than called through a data server, because the point
 * under test is that the bump is what makes the write reach a peer at all — and
 * a test that took the bump for granted would pass with it removed.
 */
async function writeMetadataThroughApi(
  db: MockDatabaseAdapter,
  clock: HLCClock,
  record: DataRecord,
  columns: Record<string, unknown>,
): Promise<void> {
  await db.putMetadata("image", { recordId: record.id, ...columns });
  const existing = (await db.get(record.id))!;
  await db.put({ ...existing, updatedAt: clock.now() });
}

async function metadataOf(
  db: MockDatabaseAdapter,
  id: StarkeepId,
): Promise<MetadataRow | null> {
  return db.getMetadata("image", id);
}

describe("metadata riding the record it belongs to", () => {
  it("ships metadata written before the record's first sync", async () => {
    const p = await makePair();
    const record = await seedPhoto(p.local, p.localStorage, p.localClock);
    await p.local.putMetadata("image", { recordId: record.id, width: 4032, height: 3024 });

    await p.engine.exchange();

    const landed = await metadataOf(p.cloud, record.id);
    expect(landed).not.toBeNull();
    expect(landed!["width"]).toBe(4032);
    expect(landed!["height"]).toBe(3024);
  });

  it("ships metadata written after the record already synced, on the next round", async () => {
    const p = await makePair();
    const record = await seedPhoto(p.local, p.localStorage, p.localClock);

    // Round one carries the record and nothing else — the production failure
    // this whole thing exists to fix: Photos registers a rendition, then writes
    // its dimensions in a second call, and any round landing between the two
    // used to ship the record forever without them.
    await p.engine.exchange();
    expect(await p.cloud.get(record.id)).not.toBeNull();
    expect(await metadataOf(p.cloud, record.id)).toBeNull();

    await writeMetadataThroughApi(p.local, p.localClock, record, {
      width: 4032,
      height: 3024,
    });
    await p.engine.exchange();

    const landed = await metadataOf(p.cloud, record.id);
    expect(landed).not.toBeNull();
    expect(landed!["width"]).toBe(4032);
  });

  it("leaves columns the snapshot does not name alone", async () => {
    const p = await makePair();
    const record = await seedPhoto(p.local, p.localStorage, p.localClock);
    await p.local.putMetadata("image", { recordId: record.id, thumb_hash: "TH" });
    // The cloud already knows the dimensions — from its own decode, or from an
    // earlier round. A snapshot naming only `thumb_hash` must not erase them,
    // which is the entire reason nulls are stripped rather than sent.
    await p.cloud.put(record);
    await p.cloud.putMetadata("image", {
      recordId: record.id,
      width: 4032,
      height: 3024,
    });

    await p.engine.exchange();

    const landed = (await metadataOf(p.cloud, record.id))!;
    expect(landed["thumb_hash"]).toBe("TH");
    expect(landed["width"]).toBe(4032);
    expect(landed["height"]).toBe(3024);
  });

  it("overwrites a column the receiver already holds", async () => {
    const p = await makePair();
    const record = await seedPhoto(p.local, p.localStorage, p.localClock);
    await p.local.putMetadata("image", { recordId: record.id, width: 4032 });
    await p.cloud.put(record);
    // A wrong value on the receiver, which is what overwrite exists for: a
    // corrected extraction has to be able to travel.
    await p.cloud.putMetadata("image", { recordId: record.id, width: 1 });

    await p.engine.exchange();

    expect((await metadataOf(p.cloud, record.id))!["width"]).toBe(4032);
  });

  it("absorbs metadata from a snapshot the receiver's own row is ahead of", async () => {
    const p = await makePair();
    const record = await seedPhoto(p.local, p.localStorage, p.localClock);
    await p.local.putMetadata("image", { recordId: record.id, width: 4032 });
    // The cloud's row is strictly newer, so LWW skips the row write. The
    // metadata must still land: the record's clock does not move when metadata
    // is written, so a newer row is no evidence at all about its metadata.
    await p.cloud.put({ ...record, updatedAt: p.cloudClock.now() });

    await p.engine.exchange();

    expect((await metadataOf(p.cloud, record.id))!["width"]).toBe(4032);
  });

  it("drops the metadata row when a tombstone applies", async () => {
    const p = await makePair();
    const record = await seedPhoto(p.local, p.localStorage, p.localClock);
    await p.local.putMetadata("image", { recordId: record.id, width: 4032 });
    await p.engine.exchange();
    expect(await metadataOf(p.cloud, record.id)).not.toBeNull();

    // A local delete cascades to the metadata row (`SdkDataOperations.delete`).
    // A synced delete has to cascade the same way, or the dimensions of a
    // deleted record outlive it on every peer but the one it was deleted on.
    const hlc = p.localClock.now();
    await p.local.delete(record.id, hlc);
    await p.local.deleteMetadata("image", record.id);
    await p.engine.exchange();

    expect((await p.cloud.get(record.id))!.deletedAt).not.toBeNull();
    expect(await metadataOf(p.cloud, record.id)).toBeNull();
  });

  it("converges on the union when two nodes write disjoint columns, in either order", async () => {
    for (const cloudFirst of [false, true]) {
      const p = await makePair();
      const record = await seedPhoto(p.local, p.localStorage, p.localClock);
      await p.cloud.put(record);
      await p.cloudStorage.put(record.objectStorageKey, new Uint8Array([1, 2, 3]));

      const writeLocal = () =>
        writeMetadataThroughApi(p.local, p.localClock, record, { width: 4032 });
      const writeCloud = async () => {
        await p.cloud.putMetadata("image", { recordId: record.id, thumb_hash: "TH" });
        const existing = (await p.cloud.get(record.id))!;
        await p.cloud.put({ ...existing, updatedAt: p.cloudClock.now() });
      };

      if (cloudFirst) {
        await writeCloud();
        await writeLocal();
      } else {
        await writeLocal();
        await writeCloud();
      }

      await p.engine.sync();

      for (const [side, db] of [
        ["local", p.local],
        ["cloud", p.cloud],
      ] as const) {
        const row = (await metadataOf(db, record.id))!;
        expect(row, `${side} (cloudFirst=${cloudFirst})`).toBeTruthy();
        expect(row["width"], `${side} width (cloudFirst=${cloudFirst})`).toBe(4032);
        expect(row["thumb_hash"], `${side} thumb_hash (cloudFirst=${cloudFirst})`).toBe("TH");
      }
    }
  });

  it("settles rather than flapping once both sides hold the union", async () => {
    const p = await makePair();
    const record = await seedPhoto(p.local, p.localStorage, p.localClock);
    await p.cloud.put(record);
    await p.cloudStorage.put(record.objectStorageKey, new Uint8Array([1, 2, 3]));
    await p.cloud.putMetadata("image", { recordId: record.id, thumb_hash: "TH" });
    const seeded = (await p.cloud.get(record.id))!;
    await p.cloud.put({ ...seeded, updatedAt: p.cloudClock.now() });
    await writeMetadataThroughApi(p.local, p.localClock, record, { width: 4032 });

    await p.engine.sync();
    const settled = await p.engine.exchange();

    // The re-ship that carries the loser's columns back is conditioned on the
    // snapshot naming a strict subset of what the receiver holds. Once both
    // sides hold the union that test is false on both, so a further round has
    // nothing to do — which is the property that separates it from the
    // unconditional bump the design rules out.
    expect(settled.applied).toBe(0);
    expect(settled.shipped).toBe(0);
  });

  it("does not re-ship when both sides name the same column", async () => {
    const p = await makePair();
    const record = await seedPhoto(p.local, p.localStorage, p.localClock);
    await p.cloud.put(record);
    await p.cloudStorage.put(record.objectStorageKey, new Uint8Array([1, 2, 3]));
    // Two decoders disagreeing about one column — a HEIC through the platform
    // decoder against the same file through sharp. The design settles that as a
    // swap on purpose, and nothing must turn it into a flap.
    await p.cloud.putMetadata("image", { recordId: record.id, thumb_hash: "FROM-CLOUD" });
    const seeded = (await p.cloud.get(record.id))!;
    await p.cloud.put({ ...seeded, updatedAt: p.cloudClock.now() });
    await writeMetadataThroughApi(p.local, p.localClock, record, {
      thumb_hash: "FROM-LOCAL",
    });

    await p.engine.sync();
    const settled = await p.engine.exchange();

    expect(settled.applied).toBe(0);
    expect(settled.shipped).toBe(0);
    expect((await metadataOf(p.local, record.id))!["thumb_hash"]).toBe(
      (await metadataOf(p.cloud, record.id))!["thumb_hash"],
    );
  });

  it("skips `other`, which has no metadata table", async () => {
    const p = await makePair();
    const record = createDataRecord(
      {
        type: "other/other",
        originAppId: "watcher",
        contentHash: "def",
        objectStorageKey: "shared/other/de/def",
        mimeType: null,
        sizeBytes: 3,
      },
      p.localClock,
    );
    await p.local.put(record);
    await p.localStorage.put(record.objectStorageKey, new Uint8Array([1, 2, 3]));

    await p.engine.exchange();

    expect(await p.cloud.get(record.id)).not.toBeNull();
    expect(await p.cloud.getMetadata("other", record.id)).toBeNull();
  });
});

describe("peers that do not speak the field", () => {
  it("leaves a responder that ignores it applying the record unchanged", async () => {
    const p = await makePair();
    const record = await seedPhoto(p.local, p.localStorage, p.localClock);
    await p.local.putMetadata("image", { recordId: record.id, width: 4032 });

    // An older responder parses the record array without validating elements
    // (`sanitizeExchangeRequest`) and writes it through a row whitelist
    // (`recordToRow`), so the extra field is neither rejected nor stored.
    // Modelled here by stripping it on the way in.
    const older: SyncTransport = {
      exchange: (request) =>
        p.transport.exchange({
          ...request,
          ...(request.records
            ? {
                records: request.records.map(({ metadata: _drop, ...rest }) => rest),
              }
            : {}),
        }),
    };
    const engine = createSyncEngine({
      localDatabaseAdapter: p.local,
      localObjectStorage: p.localStorage,
      remoteObjectStorage: p.cloudStorage,
      transport: older,
      clock: p.localClock,
      syncState: createMemorySyncStateStore(),
    });

    await engine.exchange();

    expect(await p.cloud.get(record.id)).not.toBeNull();
    expect(await metadataOf(p.cloud, record.id)).toBeNull();
  });

  it("leaves a requester's own metadata intact when the reply carries no field", async () => {
    const p = await makePair();
    // The cloud holds the record; the local node holds the record *and* the
    // metadata it derived itself. A reply with no metadata field must read as
    // "no information", never as "no value".
    const record = await seedPhoto(p.cloud, p.cloudStorage, p.cloudClock);
    await p.local.put(record);
    await p.local.putMetadata("image", { recordId: record.id, width: 4032 });

    const stripped: SyncTransport = {
      exchange: async (request) => {
        const response = await p.transport.exchange(request);
        return {
          ...response,
          records: response.records.map(({ metadata: _drop, ...rest }) => rest),
        };
      },
    };
    const engine = createSyncEngine({
      localDatabaseAdapter: p.local,
      localObjectStorage: p.localStorage,
      remoteObjectStorage: p.cloudStorage,
      transport: stripped,
      clock: p.localClock,
      syncState: createMemorySyncStateStore(),
    });

    await engine.exchange();

    expect((await metadataOf(p.local, record.id))!["width"]).toBe(4032);
  });
});
