/**
 * Residency through a real exchange round.
 *
 * The unit tests in `residency-policy.test.ts` cover the decision. These cover
 * the thing the decision exists for and that a pure-function test cannot see:
 * **a declined blob advances the watermark**, so the peer stops re-shipping the
 * record. Before this, declining and failing were the same event, which is why
 * a phone node was impossible.
 */
import { createMemorySyncStateStore } from "./sync-test-harness/memory-sync-state.js";
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  createHLCClock,
  createDataRecord,
  type StarkeepId,
} from "@starkeep/protocol-primitives";
import { MockDatabaseAdapter, MockObjectStorageAdapter } from "@starkeep/storage-adapter";
import { createSyncEngine } from "../src/sync-engine.js";
import { createInProcessSyncTransport } from "../src/transports/in-process-transport.js";
import { residencyOf } from "../src/residency.js";
import { resolveSizeClass } from "../src/residency-policy.js";
import type { BlobCandidate, ResidencyVerdict } from "../src/residency-policy.js";
import type { SyncStateStore, Watermarks } from "../src/types.js";


interface Fixture {
  engine: ReturnType<typeof createSyncEngine>;
  localStorage: MockObjectStorageAdapter;
  cloudStorage: MockObjectStorageAdapter;
  localDb: MockDatabaseAdapter;
  cloudDb: MockDatabaseAdapter;
  syncState: SyncStateStore;
  cloudRecordId: StarkeepId;
  cloudRecordKey: string;
  decisions: BlobCandidate[];
  landed: BlobCandidate[];
}

/**
 * One cloud-originated record with a blob, and a local engine whose residency
 * decision the test controls.
 */
async function setup(
  verdictFor: (c: BlobCandidate) => ResidencyVerdict,
): Promise<Fixture> {
  let time = 1000;
  const localClock = createHLCClock({ nodeId: "local", wallClockFunction: () => time++ });
  const cloudClock = createHLCClock({ nodeId: "cloud", wallClockFunction: () => time++ });

  const localDb = new MockDatabaseAdapter();
  const cloudDb = new MockDatabaseAdapter();
  const localStorage = new MockObjectStorageAdapter();
  const cloudStorage = new MockObjectStorageAdapter();
  await Promise.all([localDb.init(), cloudDb.init(), localStorage.init(), cloudStorage.init()]);

  // Real bytes and their real hash. The transfer path verifies the whole
  // object as it streams, so a fixture with a made-up content hash would fail
  // the transfer for the right reason and make this test look like a residency
  // bug.
  const blob = Buffer.from([4, 5, 6]);
  const blobHash = createHash("sha256").update(blob as unknown as Uint8Array).digest("hex");
  const cloudRecord = createDataRecord(
    {
      type: "image/jpeg",
      originAppId: "test",
      contentHash: blobHash,
      objectStorageKey: `shared/image/${blobHash.slice(0, 2)}/${blobHash}`,
      mimeType: "image/jpeg",
      sizeBytes: blob.length,
    },
    cloudClock,
  );
  await cloudDb.put(cloudRecord);
  await cloudStorage.put(cloudRecord.objectStorageKey, blob);

  const decisions: BlobCandidate[] = [];
  const landed: BlobCandidate[] = [];
  const syncState = createMemorySyncStateStore();

  const engine = createSyncEngine({
    localDatabaseAdapter: localDb,
    localObjectStorage: localStorage,
    remoteObjectStorage: cloudStorage,
    transport: createInProcessSyncTransport({
      databaseAdapter: cloudDb,
      clock: cloudClock,
      objectStorage: cloudStorage,
    }),
    clock: localClock,
    syncState,
    residency: {
      decide(candidate) {
        decisions.push(candidate);
        return verdictFor(candidate);
      },
      onLanded(candidate) {
        landed.push(candidate);
      },
    },
  });

  return {
    engine,
    localStorage,
    cloudStorage,
    localDb,
    cloudDb,
    syncState,
    cloudRecordId: cloudRecord.id,
    cloudRecordKey: cloudRecord.objectStorageKey,
    decisions,
    landed,
  };
}

// A class is a namespace and a rung, and these come from the host — so the
// fixture names one the way a host would rather than passing a bare string.
const classA = resolveSizeClass("photos", "classA");
const elide: ResidencyVerdict = { decision: "elide", sizeClass: classA, reason: "keep-never" };
const fetch: ResidencyVerdict = { decision: "fetch", sizeClass: classA, reason: "keep-all" };

describe("eliding a blob", () => {
  it("applies the metadata and skips the bytes", async () => {
    const f = await setup(() => elide);
    const result = await f.engine.exchange();

    // The record is here…
    expect(await f.localDb.get(f.cloudRecordId)).not.toBeNull();
    // …and the bytes deliberately are not.
    expect(await f.localStorage.has(f.cloudRecordKey)).toBe(false);
    expect(result.elided).toBe(1);
  });

  // The whole point. Before residency existed, a blobless record held the
  // watermark back and the peer re-shipped it every round, forever — which is
  // what made "I have the metadata and I don't want the bytes" impossible to
  // express and blocked both a phone node and any archive tier.
  it("advances the watermark, so the peer stops re-shipping it", async () => {
    const f = await setup(() => elide);
    await f.engine.exchange();

    const watermarks = await f.syncState.getWatermarks();
    expect(watermarks["cloud"]).toBeDefined();

    // Round two ships nothing: the responder sees our watermark covering the
    // record and has nothing new to send, so the decider is not consulted again.
    const before = f.decisions.length;
    const second = await f.engine.exchange();
    expect(second.applied).toBe(0);
    expect(f.decisions.length).toBe(before);
  });

  it("counts the decline separately from an applied record", async () => {
    const f = await setup(() => elide);
    const result = await f.engine.exchange();
    // Metadata landed, so `applied` counts it; the blob did not, so `elided`
    // does too. A node quietly declining everything must not look identical to
    // a healthy one.
    expect(result.applied).toBe(1);
    expect(result.elided).toBe(1);
  });

  it("does not credit byte accounting for bytes that never arrived", async () => {
    const f = await setup(() => elide);
    await f.engine.exchange();
    expect(f.landed).toHaveLength(0);
  });
});

describe("fetching a blob", () => {
  it("pulls the bytes and reports the arrival for accounting", async () => {
    const f = await setup(() => fetch);
    const result = await f.engine.exchange();

    expect(await f.localStorage.has(f.cloudRecordKey)).toBe(true);
    expect(result.elided).toBe(0);
    expect(f.landed.map((c) => c.objectStorageKey)).toEqual([f.cloudRecordKey]);
  });

  // Accounting must follow the bytes, not the intent. A node with a flaky link
  // that credited decisions would slowly convince itself it was full of things
  // it doesn't have, and then decline everything.
  it("does not report an arrival when the transfer fails", async () => {
    const f = await setup(() => fetch);
    // Remove the source bytes so the pull fails.
    await f.cloudStorage.delete(f.cloudRecordKey);

    await f.engine.exchange();
    expect(f.landed).toHaveLength(0);
    // And the watermark stayed put, so this is a retry rather than a decline.
    expect(await f.syncState.getWatermarks()).toEqual({});
  });
});

describe("the way back from a decline", () => {
  /**
   * Eliding advances the watermark, so no future round will offer these bytes
   * again. That makes `fetchBlobOnDemand` the *only* route back — and the
   * reason it must not consult the decider: it is the answer to "the user
   * opened this photo", not a policy question that would decline it again.
   *
   * Reached through `engine.fetchBlob` rather than through a bare
   * `createFileSyncEngine()`, because that is how the product reaches it: the
   * phone's placeholder tile calls `MobileNode.fetchBlob`, which calls this. A
   * separate file-sync engine would also have its own in-flight table, which is
   * exactly the collision the next case is about.
   */
  it("brings down a blob the node previously declined", async () => {
    const f = await setup(() => elide);
    await f.engine.exchange();
    expect(await f.localStorage.has(f.cloudRecordKey)).toBe(false);

    // Sync cannot help: the peer considers the record delivered.
    const another = await f.engine.sync();
    expect(another.applied).toBe(0);
    expect(await f.localStorage.has(f.cloudRecordKey)).toBe(false);

    const record = (await f.localDb.get(f.cloudRecordId))!;
    const ok = await f.engine.fetchBlob({
      objectStorageKey: record.objectStorageKey,
      fileHash: record.contentHash,
      sizeBytes: record.sizeBytes,
      ...(record.mimeType ? { mimeType: record.mimeType } : {}),
    });

    expect(ok).toBe(true);
    expect(await f.localStorage.has(f.cloudRecordKey)).toBe(true);
    // Still elided by policy — the fetch answered a request, it did not change
    // the node's mind — so the decider was never asked a second time.
    expect(f.decisions).toHaveLength(1);
  });

  it("joins a transfer already in flight rather than reporting failure", async () => {
    // Test 14. `transferFile` and `fetchBlob` are the same function over one
    // in-flight table, and a `Set` there meant the second caller got `false` —
    // indistinguishable from "the fetch failed". On a phone that is a user
    // opening a photo whose bytes a sync round happens to be pulling and being
    // told it did not work, with the placeholder still on screen.
    const f = await setup(() => fetch);
    const record = (await f.cloudDb.get(f.cloudRecordId))!;
    const manifest = {
      objectStorageKey: record.objectStorageKey,
      fileHash: record.contentHash,
      sizeBytes: record.sizeBytes,
      ...(record.mimeType ? { mimeType: record.mimeType } : {}),
    };

    // Hold the destination write open so both calls are genuinely concurrent.
    let releaseWrite: () => void = () => {};
    const writeStarted = new Promise<void>((resolve) => {
      const realPutStream = f.localStorage.putStream.bind(f.localStorage);
      f.localStorage.putStream = async (key, body, options) => {
        resolve();
        await new Promise<void>((r) => {
          releaseWrite = r;
        });
        return realPutStream(key, body, options);
      };
    });

    const first = f.engine.fetchBlob(manifest);
    await writeStarted;
    const second = f.engine.fetchBlob(manifest);
    releaseWrite();

    expect(await first).toBe(true);
    expect(
      await second,
      "a caller that arrived mid-transfer must be told what happened, not told no",
    ).toBe(true);
    expect(await f.localStorage.has(f.cloudRecordKey)).toBe(true);
  });

  it("re-ships a previously elided record when a repair floor asks for it", async () => {
    // A repair lowers the *advertised* watermark, so the responder re-ships
    // rows the elision had already carried past. What comes back down is the
    // row, and the decision is taken again from scratch — which is what makes a
    // budget change take effect on a library that was declined under the old
    // one, and what stops a repair from silently reversing a policy that has
    // not changed.
    let verdict: ResidencyVerdict = elide;
    const f = await setup(() => verdict);
    await f.engine.exchange();
    expect(await f.localStorage.has(f.cloudRecordKey)).toBe(false);
    const covered = await f.syncState.getWatermarks();
    expect(covered["cloud"]).toBeDefined();

    // Arm the inbound repair the way `verify()` does: advertise less than we
    // hold, from below the record.
    await f.syncState.setInboundFloors({
      cloud: { wallTime: 0, counter: 0, nodeId: "cloud" },
    });

    verdict = fetch;
    await f.engine.exchange();

    // The row itself is an LWW no-op — we already had it, which is why
    // `applied` stays at zero — but the *decision* is taken again, and this
    // time it wants the bytes.
    expect(f.decisions.length).toBeGreaterThan(1);
    expect(await f.localStorage.has(f.cloudRecordKey)).toBe(true);
    expect(f.landed.map((c) => c.objectStorageKey)).toEqual([f.cloudRecordKey]);
  });
});

describe("a failed fetch is not a decline", () => {
  // These two states are indistinguishable from the blob's absence alone, and
  // conflating them is exactly the bug residency exists to fix: one must retry
  // forever, the other must never retry.
  it("holds the watermark on failure and advances it on decline", async () => {
    const failing = await setup(() => fetch);
    await failing.cloudStorage.delete(failing.cloudRecordKey);
    await failing.engine.exchange();
    expect(await failing.syncState.getWatermarks()).toEqual({});

    const declining = await setup(() => elide);
    await declining.engine.exchange();
    expect(Object.keys(await declining.syncState.getWatermarks())).toEqual(["cloud"]);
  });
});

describe("residencyOf names the two ways a blob can be missing", () => {
  const row = {
    id: "r1",
    object_storage_key: "shared/image/aa/" + "a".repeat(64),
    content_hash: "a".repeat(64),
    mime_type: "image/jpeg",
    size_bytes: 3,
    original_filename: null,
    origin_app_id: "test",
    created_at: "x",
    updated_at: "x",
    deleted_at: null,
  };

  it("reports resident when the blob is here", async () => {
    const storage = new MockObjectStorageAdapter();
    await storage.init();
    await storage.put(row.object_storage_key, new Uint8Array([1]));
    expect(await residencyOf(row, storage)).toBe("resident");
  });

  // Without a decider every blobless row reads as "still owed" — the exact
  // conflation that made Elided impossible.
  it("reports staged with no decider, and elided when the node declined it", async () => {
    const storage = new MockObjectStorageAdapter();
    await storage.init();
    expect(await residencyOf(row, storage)).toBe("staged");
    expect(await residencyOf(row, storage, () => "elide")).toBe("elided");
    expect(await residencyOf(row, storage, () => "fetch")).toBe("staged");
  });

  // Elided-ness is re-evaluated rather than stored, so raising a budget makes a
  // record staged again with no migration and no stale flag to clean up.
  it("follows current policy rather than a stored flag", async () => {
    const storage = new MockObjectStorageAdapter();
    await storage.init();
    let declining = true;
    const decide = () => (declining ? "elide" as const : "fetch" as const);
    expect(await residencyOf(row, storage, decide)).toBe("elided");
    declining = false;
    expect(await residencyOf(row, storage, decide)).toBe("staged");
  });

  it("reports tombstoned regardless of the blob or the policy", async () => {
    const storage = new MockObjectStorageAdapter();
    await storage.init();
    expect(await residencyOf({ ...row, deleted_at: "t" }, storage, () => "elide")).toBe(
      "tombstoned",
    );
  });

  it("reports absent for no row at all", async () => {
    const storage = new MockObjectStorageAdapter();
    await storage.init();
    expect(await residencyOf(null, storage)).toBe("absent");
  });
});
