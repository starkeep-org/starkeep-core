/**
 * The uploader on its own: the queue, its order, its failures, and how it
 * corrects itself against the cloud's bytes watermark.
 *
 * Driven through a fake target, so each test can say what the cloud answers
 * and watch the order transfers start in. Every case runs against both
 * stores: the memory one tests and one-off engines use, and the SQLite one
 * every real node uses.
 */

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  createDataRecord,
  generateId,
  type HLCTimestamp,
  type StarkeepId,
} from "@starkeep/protocol-primitives";
import { MockDatabaseAdapter, MockObjectStorageAdapter } from "@starkeep/storage-adapter";
import {
  createUploader,
  type UploadAnswer,
  type UploadBatchReport,
  type UploadItem,
  type UploadTarget,
} from "../src/uploader.js";
import {
  createMemoryUploadQueueStore,
  createSqliteUploadQueueStore,
  type UploadQueueStore,
} from "../src/upload-queue-store.js";
import type { Watermarks } from "../src/types.js";
import { createTestUploaderClock } from "./sync-test-harness/uploader-clock.js";

const MB = 1024 * 1024;
const AUTHOR = "P";

const stores: Array<[string, () => UploadQueueStore]> = [
  ["memory", () => createMemoryUploadQueueStore()],
  [
    "sqlite",
    () => createSqliteUploadQueueStore({ db: new DatabaseSync(":memory:"), channel: "drive" }),
  ],
];

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/** A cloud the test scripts: what it holds, refuses, and how each PUT goes. */
function fakeCloud() {
  const holds = new Set<string>();
  const refuses = new Set<string>();
  const started: string[] = [];
  const prepared: string[][] = [];
  const reports: UploadBatchReport[] = [];
  let prepareError: Error | null = null;
  let failSend: (key: string) => Error | null = () => null;
  let gate: ((key: string) => Promise<void>) | null = null;

  const target: UploadTarget = {
    usesParts: () => false,
    async prepare(items: readonly UploadItem[], report: UploadBatchReport) {
      reports.push(report);
      if (prepareError) throw prepareError;
      prepared.push(items.map((i) => i.file.key));
      return items.map((i): UploadAnswer => {
        if (holds.has(i.file.key)) return { status: "present" };
        if (refuses.has(i.file.key)) return { status: "refused", reason: "no-cloud" };
        return { status: "signed", signed: { url: `https://s3/${i.file.key}` } };
      });
    },
    async send(item) {
      started.push(item.file.key);
      if (gate) await gate(item.file.key);
      const err = failSend(item.file.key);
      if (err) throw err;
      holds.add(item.file.key);
    },
  };
  return {
    target,
    holds,
    refuses,
    started,
    prepared,
    reports,
    failPrepare(err: Error | null) {
      prepareError = err;
    },
    failSendWith(fn: (key: string) => Error | null) {
      failSend = fn;
    },
    gateSends(fn: ((key: string) => Promise<void>) | null) {
      gate = fn;
    },
  };
}

async function setup(makeStore: () => UploadQueueStore, store = makeStore()) {
  const db = new MockDatabaseAdapter();
  const local = new MockObjectStorageAdapter();
  await db.init();
  await local.init();
  const cloud = fakeCloud();
  const clock = createTestUploaderClock();
  let cloudBytes: Watermarks | null = {};
  const internals = createUploader({
    sources: { records: db, fileTables: [] },
    records: db,
    localObjectStorage: local,
    target: cloud.target,
    store,
    loadCloudBytes: async () => cloudBytes,
    timers: clock,
  });
  let wall = 0;
  /** A record by `AUTHOR` at a given time, with its bytes on this node unless told otherwise. */
  async function seed(
    sizeBytes: number,
    options: { parentId?: StarkeepId; held?: boolean; at?: number } = {},
  ): Promise<{ id: StarkeepId; key: string; hlc: HLCTimestamp }> {
    wall = options.at ?? wall + 1;
    const id = generateId() as StarkeepId;
    const key = `shared/image/${id}`;
    if (options.held !== false) await local.put(key, new Uint8Array(8));
    const hlc = { wallTime: wall, counter: 0, nodeId: AUTHOR };
    const base = createDataRecord(
      {
        type: "image/jpeg",
        originAppId: "photos",
        contentHash: `sha256:${id}`,
        objectStorageKey: key,
        mimeType: "image/jpeg",
        sizeBytes,
        ...(options.parentId ? { parentId: options.parentId } : {}),
      },
      { now: () => hlc, receive: () => hlc } as never,
    );
    await db.put({ ...base, id, updatedAt: hlc, createdAt: hlc });
    return { id, key, hlc };
  }
  /**
   * Let discovery queue everything, with the cloud's presign down so nothing
   * is sent, and leave the uploader stopped with its queue full.
   */
  async function queueWithoutSending(): Promise<void> {
    cloud.failPrepare(new Error("presign batch of 1 failed: 503 Service Unavailable"));
    internals.uploader.start();
    await settle();
    internals.uploader.stop();
    cloud.failPrepare(null);
  }
  return {
    db,
    local,
    cloud,
    clock,
    store,
    queueWithoutSending,
    uploader: internals.uploader,
    afterExchange: internals.afterExchange,
    seed,
    setCloudBytes(marks: Watermarks | null) {
      cloudBytes = marks;
    },
  };
}

describe.each(stores)("uploader (%s store)", (_name, makeStore) => {
  it("sends the fast tier newest first, then originals oldest first", async () => {
    const w = await setup(makeStore);
    const o1 = await w.seed(3 * MB);
    const o2 = await w.seed(3 * MB);
    const s1 = await w.seed(100_000, { parentId: o1.id });
    const s2 = await w.seed(100_000, { parentId: o2.id });

    await w.uploader.drain();

    expect(w.cloud.started).toEqual([s2.key, s1.key, o1.key, o2.key]);
    // One request per tier: fast entries never share a batch with originals.
    expect(w.cloud.prepared).toEqual([
      [s2.key, s1.key],
      [o1.key, o2.key],
    ]);
  });

  it("lets a new stand-in jump the original backlog", async () => {
    const w = await setup(makeStore);
    const originals: Array<{ id: StarkeepId; key: string }> = [];
    for (let i = 0; i < 6; i += 1) originals.push(await w.seed(3 * MB));
    const release: Array<() => void> = [];
    w.cloud.gateSends(async (key) => {
      if (originals.some((o) => o.key === key)) {
        await new Promise<void>((resolve) => release.push(resolve));
      }
    });

    w.uploader.start();
    await settle();
    // Two originals hold the large lane.
    expect(w.cloud.started).toEqual([originals[0]!.key, originals[1]!.key]);

    const standIn = await w.seed(80_000, { parentId: originals[5]!.id });
    w.uploader.nudge();
    await settle();
    expect(w.cloud.started).toContain(standIn.key);

    for (const r of release.splice(0)) r();
    await settle();
    expect(w.cloud.started.indexOf(standIn.key)).toBeLessThan(
      w.cloud.started.indexOf(originals[2]!.key),
    );
    w.cloud.gateSends(null);
    for (const r of release.splice(0)) r();
    await w.uploader.drain();
    w.uploader.stop();
    expect(w.uploader.stats().sent.count).toBe(7);
  });

  it("backs a failed file off, and tries it again once the backoff runs out", async () => {
    const w = await setup(makeStore);
    const file = await w.seed(3 * MB);
    let failing = true;
    w.cloud.failSendWith(() =>
      failing ? new Error("S3 PUT x failed: 500 — InternalError") : null,
    );

    await w.uploader.drain();
    expect(w.store.get(file.key)?.attempts).toBe(1);
    expect(w.uploader.stats().backingOff).toBe(1);

    failing = false;
    w.clock.advance(29_000);
    await w.uploader.drain();
    expect(w.cloud.started).toEqual([file.key]);

    w.clock.advance(2_000);
    await w.uploader.drain();
    expect(w.cloud.started).toEqual([file.key, file.key]);
    expect(w.store.get(file.key)).toBeNull();
    expect(w.store.sent(file.key)).not.toBeNull();
  });

  it("pauses on an outage without counting it against any file", async () => {
    const w = await setup(makeStore);
    const a = await w.seed(2 * MB);
    const b = await w.seed(2 * MB);
    let offline = true;
    w.cloud.failSendWith(() => (offline ? new TypeError("Network request failed") : null));

    w.uploader.start();
    await settle();
    expect(w.uploader.stats().state).toBe("paused");
    expect(w.store.get(a.key)?.attempts).toBe(0);
    expect(w.store.get(b.key)?.attempts).toBe(0);

    // Connectivity comes back: a nudge lifts the pause.
    offline = false;
    w.uploader.nudge();
    await w.uploader.drain();
    w.uploader.stop();
    expect(w.uploader.stats().sent.count).toBe(2);
  });

  it("pauses when the presign request itself fails, and counts no attempt", async () => {
    const w = await setup(makeStore);
    const file = await w.seed(2 * MB);
    w.cloud.failPrepare(new TypeError("Network request failed"));

    w.uploader.start();
    await settle();
    expect(w.uploader.stats().state).toBe("paused");
    expect(w.store.get(file.key)?.attempts).toBe(0);

    w.cloud.failPrepare(null);
    w.uploader.nudge();
    await w.uploader.drain();
    w.uploader.stop();
    expect(w.store.sent(file.key)).not.toBeNull();
  });

  it("blocks a file whose bytes went away, and readies it when they return", async () => {
    const w = await setup(makeStore);
    const file = await w.seed(2 * MB);
    const other = await w.seed(2 * MB);
    // Discovered while held, gone by the time the scheduler takes it.
    await w.queueWithoutSending();
    expect(w.store.get(file.key)?.state).toBe("ready");
    await w.local.delete(file.key);

    w.uploader.nudge();
    await w.uploader.drain();
    expect(w.store.get(file.key)?.state).toBe("blocked-not-held");
    expect(w.uploader.stats().blocked.count).toBe(1);
    // The blocked file holds back nothing else.
    expect(w.store.sent(other.key)).not.toBeNull();

    await w.local.put(file.key, new Uint8Array(8));
    w.uploader.nudge();
    await w.uploader.drain();
    expect(w.store.sent(file.key)).not.toBeNull();
  });

  it("drops a queued file whose record was deleted, or marked no-cloud, or refused", async () => {
    const w = await setup(makeStore);
    const deleted = await w.seed(2 * MB);
    const labelled = await w.seed(2 * MB);
    const refused = await w.seed(2 * MB);
    const kept = await w.seed(2 * MB);
    await w.queueWithoutSending();
    expect(w.uploader.stats().queued.full.count).toBe(4);

    const record = (await w.db.get(deleted.id))!;
    await w.db.put({ ...record, deletedAt: record.updatedAt });
    const at = { wallTime: 100, counter: 0, nodeId: AUTHOR };
    await w.db.putLabel({
      recordId: labelled.id,
      appId: "starkeep",
      key: "no-cloud",
      value: "",
      recordType: "image/jpeg",
      createdAt: at,
      updatedAt: at,
      nodeId: AUTHOR,
      deletedAt: null,
    });
    w.cloud.refuses.add(refused.key);

    w.uploader.nudge();
    await w.uploader.drain();
    expect(w.cloud.started).toEqual([kept.key]);
    for (const key of [deleted.key, labelled.key, refused.key]) {
      expect(w.store.get(key)).toBeNull();
      expect(w.store.sent(key)).toBeNull();
    }
  });

  it("leaves a file the cloud already holds without sending it", async () => {
    const w = await setup(makeStore);
    const file = await w.seed(2 * MB);
    w.cloud.holds.add(file.key);
    await w.uploader.drain();
    expect(w.cloud.started).toEqual([]);
    expect(w.store.get(file.key)).toBeNull();
  });

  it("reads a whole library in pages on its first run", async () => {
    const w = await setup(makeStore);
    for (let i = 0; i < 2_100; i += 1) await w.seed(1_000);
    await w.uploader.drain();
    expect(w.uploader.stats().sent.count).toBe(2_100);
  });

  it("idles until the round has saved a watermark", async () => {
    const w = await setup(makeStore);
    w.setCloudBytes(null);
    await w.seed(2 * MB);
    await w.uploader.drain();
    expect(w.cloud.prepared).toEqual([]);

    w.setCloudBytes({});
    await w.uploader.drain();
    expect(w.uploader.stats().sent.count).toBe(1);
  });

  it("reads files again when the cloud's watermark drops (rule 1)", async () => {
    const w = await setup(makeStore);
    const a = await w.seed(2 * MB);
    const b = await w.seed(2 * MB);
    const c = await w.seed(2 * MB);
    await w.uploader.drain();
    expect(w.uploader.stats().sent.count).toBe(3);

    // The cloud's walk passes every file, and the sent table forgets them.
    w.setCloudBytes({ [AUTHOR]: c.hlc });
    w.afterExchange(w.clock.now());
    await w.uploader.drain();
    expect(w.store.sent(c.key)).toBeNull();

    // The cloud loses everything above `a`, and its watermark drops. Its walk
    // climbs back before the uploader looks again, as a retiring repair floor
    // lets it. The re-read happens anyway, and only the lost file is sent.
    w.cloud.holds.delete(b.key);
    w.setCloudBytes({ [AUTHOR]: a.hlc });
    w.afterExchange(null);
    await settle();
    w.setCloudBytes({ [AUTHOR]: c.hlc });
    w.cloud.prepared.length = 0;
    w.cloud.started.length = 0;
    await w.uploader.drain();
    expect(w.cloud.prepared.flat().sort()).toEqual([b.key, c.key].sort());
    expect(w.cloud.started).toEqual([b.key]);
  });

  it("sends again a file the cloud's walk stopped at after it was sent (rule 2)", async () => {
    const w = await setup(makeStore);
    const a = await w.seed(2 * MB);
    await w.seed(2 * MB);
    await w.uploader.drain();
    expect(w.cloud.started).toHaveLength(2);

    // The cloud lost `a` behind the PUT's back, and an exchange that began
    // after the send stopped its walk there.
    w.cloud.holds.delete(a.key);
    w.clock.advance(1_000);
    w.afterExchange(w.clock.now());
    await w.uploader.drain();
    expect(w.cloud.started.filter((k) => k === a.key)).toHaveLength(2);
  });

  it("does not resend a pin sent after the exchange began", async () => {
    const w = await setup(makeStore);
    const a = await w.seed(2 * MB);
    const exchangeBegan = w.clock.now();
    w.clock.advance(1_000);
    await w.uploader.drain();
    w.afterExchange(exchangeBegan);
    await w.uploader.drain();
    expect(w.cloud.started).toEqual([a.key]);
  });

  it("sends a pin whose bytes arrived after discovery passed its row (rule 2)", async () => {
    const w = await setup(makeStore);
    const late = await w.seed(2 * MB, { held: false });
    const after = await w.seed(2 * MB);
    await w.uploader.drain();
    expect(w.cloud.started).toEqual([after.key]);

    await w.local.put(late.key, new Uint8Array(8));
    w.afterExchange(w.clock.now());
    await w.uploader.drain();
    expect(w.cloud.started).toEqual([after.key, late.key]);
  });

  it("reports its activity on each request, and batches an earlier run left open", async () => {
    const store = makeStore();
    store.openBatch({ id: "earlier", startedAt: 5_000, items: 3 });
    const w = await setup(makeStore, store);
    const ok = await w.seed(2 * MB);
    const bad = await w.seed(2 * MB);
    w.cloud.failSendWith((key) =>
      key === bad.key ? new Error("S3 PUT failed: 403 — Denied") : null,
    );
    await w.uploader.drain();

    const first = w.cloud.reports[0]!;
    expect(first.sinceMs).toBeNull();
    expect(first.unfinishedBatches).toEqual([
      { id: "earlier", startedAt: new Date(5_000).toISOString(), items: 3 },
    ]);
    expect(first.state).toBe("draining");

    w.clock.advance(60 * 60 * 1000);
    w.cloud.failSendWith(() => null);
    await w.uploader.drain();
    const second = w.cloud.reports[1]!;
    expect(second.unfinishedBatches).toBeUndefined();
    expect(second.succeeded.full).toEqual({ count: 1, bytes: 2 * MB });
    expect(second.failureCount).toBe(1);
    expect(second.failures[0]).toMatchObject({ sizeBytes: 2 * MB });
    expect(second.failures[0]!.error).toContain("403");
    expect(w.store.sent(ok.key)).not.toBeNull();
    // Every batch this run opened was closed when its transfers settled.
    expect(w.store.openBatches()).toEqual([]);
  });
});

describe("SQLite upload queue store", () => {
  it("keeps the queue, the sent table and the cursors across a reopen", () => {
    const db = new DatabaseSync(":memory:");
    const first = createSqliteUploadQueueStore({ db, channel: "drive" });
    const hlc = { wallTime: 10, counter: 0, nodeId: AUTHOR };
    const file = {
      key: "shared/image/abc",
      hlc,
      recordId: null,
      itemId: "abc",
      sizeBytes: 5,
      fileHash: "abc",
      mimeType: null,
      tier: "fast" as const,
    };
    first.enqueue(file);
    first.enqueue({ ...file, key: "shared/image/def" });
    first.markSent("shared/image/def", 99);
    first.setCursor(AUTHOR, hlc);

    const again = createSqliteUploadQueueStore({ db, channel: "drive" });
    expect(again.get(file.key)?.hlc).toEqual(hlc);
    expect(again.sent("shared/image/def")?.sentAt).toBe(99);
    expect(again.cursors()).toEqual({ [AUTHOR]: hlc });
    // Another channel in the same database sees none of it.
    const other = createSqliteUploadQueueStore({ db, channel: "photos" });
    expect(other.get(file.key)).toBeNull();
    expect(other.cursors()).toEqual({});
  });

  it("never lets an older row version replace a newer one", () => {
    const store = createSqliteUploadQueueStore({ db: new DatabaseSync(":memory:"), channel: "c" });
    const newer = { wallTime: 20, counter: 0, nodeId: AUTHOR };
    const older = { wallTime: 10, counter: 0, nodeId: AUTHOR };
    const file = {
      key: "k",
      hlc: newer,
      recordId: null,
      itemId: "k",
      sizeBytes: 5,
      fileHash: "k",
      mimeType: null,
      tier: "full" as const,
    };
    store.enqueue(file);
    store.recordFailure("k", 2, 500, "boom");
    store.enqueue({ ...file, hlc: older, sizeBytes: 9 });
    expect(store.get("k")?.sizeBytes).toBe(5);
    store.enqueue({ ...file, hlc: { ...newer, wallTime: 30 }, sizeBytes: 7 });
    expect(store.get("k")).toMatchObject({ sizeBytes: 7, attempts: 2, state: "ready" });
  });
});
