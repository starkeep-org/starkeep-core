/**
 * The reaper: the only thing that reclaims the bytes of a deleted item, and the
 * only thing that hard-deletes anything.
 *
 * Every case here would leak storage, destroy bytes the person was promised, or
 * cost money in an archive tier if the guard it covers went away.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  createDataRecord,
  createHLCClock,
  serializeHLC,
  type DataRecord,
  type StarkeepId,
} from "@starkeep/protocol-primitives";
import { MockDatabaseAdapter, MockObjectStorageAdapter } from "@starkeep/storage-adapter";
import { reapDeleted } from "../src/reaper.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 6);
const clock = createHLCClock({ nodeId: "node-a" });

let db: MockDatabaseAdapter;
let storage: MockObjectStorageAdapter;
let n = 0;

beforeEach(async () => {
  db = new MockDatabaseAdapter();
  storage = new MockObjectStorageAdapter();
  await db.init();
  await storage.init();
});

/** A record with bytes in this host's store. */
async function put(
  over: { key?: string; size?: number; filename?: string; type?: string } = {},
): Promise<DataRecord> {
  const hash = `hash-${n++}`;
  const key = over.key ?? `shared/image/aa/${hash}`;
  const record = createDataRecord(
    {
      type: over.type ?? "image/jpeg",
      originAppId: "photos",
      contentHash: hash,
      objectStorageKey: key,
      sizeBytes: over.size ?? 4096,
      originalFilename: over.filename ?? `f-${n}.jpg`,
    },
    clock,
  );
  await db.put(record);
  if (!(await storage.has(key))) await storage.put(key, new Uint8Array(record.sizeBytes));
  return record;
}

/** Tombstone a record `daysAgo` days before `NOW`, with the cascade a delete writes. */
async function deleteDaysAgo(record: DataRecord, daysAgo: number): Promise<void> {
  const hlc = { wallTime: NOW - daysAgo * MS_PER_DAY, counter: 0, nodeId: "node-a" };
  await db.delete(record.id as StarkeepId, hlc);
  await db.tombstoneMetadata(record.type, record.id as StarkeepId, hlc);
  await db.tombstoneLabelsForRecord(record.id as StarkeepId, hlc);
}

const reap = (retentionDays: number | null, dryRun = false) =>
  reapDeleted({ databaseAdapter: db, objectStorage: storage }, { retentionDays, dryRun, nowMs: NOW });

/** A reap on a host whose store only links to the given keys. */
const reapBorrowing = (borrowed: readonly string[], retentionDays = 30) =>
  reapDeleted(
    { databaseAdapter: db, objectStorage: storage, borrowsBytes: (key) => borrowed.includes(key) },
    { retentionDays, nowMs: NOW },
  );

describe("the retention window", () => {
  it("reaps bytes deleted before the window and leaves the rest", async () => {
    const old = await put({ size: 1000 });
    const recent = await put({ size: 2000 });
    await deleteDaysAgo(old, 31);
    await deleteDaysAgo(recent, 29);

    const report = await reap(30);
    expect(report.reaped.map((r) => r.objectStorageKey)).toEqual([old.objectStorageKey]);
    expect(report.reclaimedBytes).toBe(1000);
    expect(await storage.has(old.objectStorageKey)).toBe(false);
    expect(await storage.has(recent.objectStorageKey)).toBe(true);
    // Never the record row: `verify()` counts tombstones, so a missing one reads as
    // a hole and gets re-shipped from a peer.
    expect(await db.get(old.id as StarkeepId)).not.toBeNull();
    expect(report.retentionDays).toBe(30);
  });

  it("honours a window the settings file widened", async () => {
    const record = await put();
    await deleteDaysAgo(record, 100);
    expect((await reap(365)).reaped).toEqual([]);
    expect((await reap(90)).reaped).toHaveLength(1);
  });

  it("reaps nothing at all when this host cannot read the window", async () => {
    // A host in the dark about the library's value. Reaping to the default under a
    // library whose owner chose a year would destroy bytes the person was promised,
    // and nothing can record "reaped under a guess" and be corrected later.
    const record = await put();
    await deleteDaysAgo(record, 1000);
    const report = await reap(null);
    expect(report).toMatchObject({ reaped: [], reclaimedBytes: 0, retentionDays: null });
    expect(await storage.has(record.objectStorageKey)).toBe(true);
  });

  it("estimates without removing on a dry run", async () => {
    const record = await put({ size: 777 });
    await deleteDaysAgo(record, 60);
    const report = await reap(30, true);
    expect(report).toMatchObject({ dryRun: true, reclaimedBytes: 777 });
    expect(report.reaped).toHaveLength(1);
    expect(await storage.has(record.objectStorageKey)).toBe(true);
  });
});

describe("the refcount over the object key", () => {
  it("leaves bytes a live record still holds", async () => {
    // Object keys name bytes, so two files with identical content under two names
    // are two records sharing one object. Reaping on one record's tombstone would
    // take the other's bytes.
    const key = "shared/image/bb/shared-bytes";
    const deleted = await put({ key, filename: "one.jpg" });
    const live = await put({ key, filename: "two.jpg" });
    expect(live.objectStorageKey).toBe(key);
    await deleteDaysAgo(deleted, 60);

    const report = await reap(30);
    expect(report.reaped).toEqual([]);
    expect(report.refused).toEqual([
      { objectStorageKey: key, reason: "live-record", detail: `${live.id} still holds these bytes` },
    ]);
    expect(await storage.has(key)).toBe(true);
  });

  it("reaps once every record on the key is past the window", async () => {
    const key = "shared/image/cc/shared-bytes";
    const first = await put({ key, filename: "one.jpg" });
    const second = await put({ key, filename: "two.jpg" });
    await deleteDaysAgo(first, 60);
    await deleteDaysAgo(second, 60);

    const report = await reap(30);
    expect(report.reaped).toHaveLength(1);
    expect([...report.reaped[0]!.recordIds].sort()).toEqual([first.id, second.id].sort());
    expect(await storage.has(key)).toBe(false);
  });

  it("waits for the newest tombstone on the key, not the oldest", async () => {
    // The promise was made about the most recent delete. Taking the oldest would
    // reap bytes a record deleted yesterday still refers to.
    const key = "shared/image/dd/shared-bytes";
    const first = await put({ key, filename: "one.jpg" });
    const second = await put({ key, filename: "two.jpg" });
    await deleteDaysAgo(first, 60);
    await deleteDaysAgo(second, 2);

    const report = await reap(30);
    expect(report.reaped).toEqual([]);
    expect(report.refused.map((r) => r.reason)).toEqual(["within-window"]);
    expect(await storage.has(key)).toBe(true);
  });

  it("finds the newest tombstone on a key shared by more records than one page holds", async () => {
    // The same image under hundreds of filenames is the case the key-wide refcount
    // exists for, so the check reads every record on the key rather than a page.
    const key = "shared/image/ee/widely-duplicated";
    for (let i = 0; i < 600; i++) {
      await deleteDaysAgo(await put({ key, filename: `copy-${i}.jpg` }), 60);
    }
    const recent = await put({ key, filename: "copy-recent.jpg" });
    await db.putMetadata("image/jpeg", { recordId: recent.id, width: 4032 });
    await deleteDaysAgo(recent, 2);

    const report = await reap(30);
    expect(report.reaped).toEqual([]);
    expect(report.refused.map((r) => r.reason)).toEqual(["within-window"]);
    expect(await storage.has(key)).toBe(true);
    expect(await db.getMetadata("image", recent.id)).not.toBeNull();
  });
});

describe("the rows that ride on a reaped record", () => {
  it("hard-deletes the metadata row and the label rows, and no record row", async () => {
    const record = await put();
    await db.putMetadata("image/jpeg", { recordId: record.id, width: 4032, height: 3024 });
    await db.upsertLabels([
      {
        recordId: record.id as StarkeepId,
        appId: "photos",
        key: "favourite",
        value: "",
        recordType: "image/jpeg",
        hlc: clock.now(),
      },
    ]);
    await deleteDaysAgo(record, 60);
    // Still there, which is what makes a restore inside the window complete.
    expect(await db.getMetadata("image", record.id)).not.toBeNull();

    await reap(30);

    expect(await db.getMetadata("image", record.id)).toBeNull();
    expect(await db.getLabel(record.id as StarkeepId, "photos", "favourite", "")).toBeNull();
    expect(await db.get(record.id as StarkeepId)).not.toBeNull();
  });

  it("leaves a metadata row whose record is still inside the window", async () => {
    const record = await put();
    await db.putMetadata("image/jpeg", { recordId: record.id, width: 4032 });
    await deleteDaysAgo(record, 10);
    await reap(30);
    expect(await db.getMetadata("image", record.id)).not.toBeNull();
  });
});

describe("an archived object", () => {
  it("is skipped and counted, because deleting it early is charged anyway", async () => {
    // Deep Archive owes a 180-day minimum storage duration, so an early delete is
    // billed as if the object had stayed. The exception is counted in the report so
    // the standing cost it accepts stays visible.
    const record = await put();
    await deleteDaysAgo(record, 60);
    storage.setAvailability(record.objectStorageKey, {
      state: "archived",
      tier: "DEEP_ARCHIVE",
      expectedLatencyHours: 12,
    });

    const report = await reap(30);
    expect(report.reaped).toEqual([]);
    expect(report.archivedSkipped).toBe(1);
    expect(report.refused.map((r) => r.reason)).toEqual(["archived"]);
    expect(await storage.has(record.objectStorageKey)).toBe(true);
  });
});

describe("a restored record", () => {
  it("is not reaped, because its tombstone is gone", async () => {
    const record = await put();
    await deleteDaysAgo(record, 60);
    // The restore, as `applyRecordRestore` writes it.
    const tombstoned = (await db.get(record.id as StarkeepId))!;
    await db.put({
      ...tombstoned,
      deletedAt: null,
      updatedAt: clock.now(),
      version: tombstoned.version + 1,
    });

    const report = await reap(30);
    expect(report.reaped).toEqual([]);
    expect(report.keysConsidered).toBe(0);
    expect(await storage.has(record.objectStorageKey)).toBe(true);
  });
});

describe("bytes this host does not hold", () => {
  it("are refused rather than counted as reclaimed", async () => {
    // Every host reaps its own store. A node that evicted the file long ago has
    // nothing to reclaim and must not report bytes it never had.
    const record = await put();
    await storage.delete(record.objectStorageKey);
    await deleteDaysAgo(record, 60);

    const report = await reap(30);
    expect(report.reaped).toEqual([]);
    expect(report.reclaimedBytes).toBe(0);
    expect(report.refused.map((r) => r.reason)).toEqual(["absent"]);
  });
});

describe("bytes this host only links to", () => {
  it("are refused rather than unlinked and counted as reclaimed", async () => {
    // A watched file is symlinked into the object store, so its bytes belong to the
    // person's folder. Reaping the key would free nothing and report the file's
    // whole size as reclaimed, which is the one number in this report a person
    // would act on.
    const record = await put({ size: 9000 });
    await deleteDaysAgo(record, 60);

    const report = await reapBorrowing([record.objectStorageKey]);
    expect(report.reaped).toEqual([]);
    expect(report.reclaimedBytes).toBe(0);
    expect(report.refused.map((r) => r.reason)).toEqual(["borrowed"]);
    expect(await storage.has(record.objectStorageKey)).toBe(true);
  });

  it("keep the rows a restore needs, because the bytes are still readable here", async () => {
    // The byte deletion carries the metadata and label rows, and a hard-deleted
    // metadata row is gone for good. On a host that still holds the bytes the
    // restore is worth something, so nothing about the record is destroyed.
    const record = await put();
    await db.putMetadata("image/jpeg", { recordId: record.id, width: 4032, height: 3024 });
    await deleteDaysAgo(record, 60);

    await reapBorrowing([record.objectStorageKey]);

    expect(await db.getMetadata("image", record.id)).not.toBeNull();
  });

  it("does not excuse a held key sharing the pass", async () => {
    const borrowed = await put({ size: 9000 });
    const held = await put({ size: 1000 });
    await deleteDaysAgo(borrowed, 60);
    await deleteDaysAgo(held, 60);

    const report = await reapBorrowing([borrowed.objectStorageKey]);
    expect(report.reaped.map((r) => r.objectStorageKey)).toEqual([held.objectStorageKey]);
    expect(report.reclaimedBytes).toBe(1000);
    expect(await storage.has(borrowed.objectStorageKey)).toBe(true);
    expect(await storage.has(held.objectStorageKey)).toBe(false);
  });
});

describe("the age bound", () => {
  it("is lexicographic over the serialized HLC, so the database applies it directly", async () => {
    // The format is what makes this exact: a zero-padded hex wall time in
    // milliseconds leads the string, so string order is time order.
    const early = serializeHLC({ wallTime: NOW - 40 * MS_PER_DAY, counter: 0, nodeId: "z" });
    const late = serializeHLC({ wallTime: NOW - 20 * MS_PER_DAY, counter: 0, nodeId: "a" });
    expect(early < late).toBe(true);
  });
});
