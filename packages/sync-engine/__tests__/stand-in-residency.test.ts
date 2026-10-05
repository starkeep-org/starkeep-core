/**
 * Residency: a node may go without a file only because a stand-in can replace
 * it, and only above the node's sync-down ceiling. Every other file arrives on
 * every node and stays. Nothing removes a file automatically; "Free up space"
 * removes one only after proving cloud copies.
 *
 * The bar is the one the old eviction suites stated: every case that asserts a
 * file is *kept* would delete or withhold a wanted file if the guard it covers
 * went away.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  createDataRecord,
  createHLCClock,
  DEFAULT_STAND_IN_STANDARDS,
  DEFAULT_SYNC_DOWN_CEILINGS,
  standardsFor,
  type DataRecord,
  type StandInRole,
  type StarkeepId,
} from "@starkeep/protocol-primitives";
import {
  MockDatabaseAdapter,
  MockObjectStorageAdapter,
  type DatabaseAdapter,
} from "@starkeep/storage-adapter";
import {
  createResidencyManager,
  residencyHooks,
  KEPT_GROUP,
  NO_CLOUD_LABEL_KEY,
  STARKEEP_LABEL_APP_ID,
  type ResidencyManager,
} from "../src/residency-manager.js";
import { createSyncEngine } from "../src/sync-engine.js";
import { createInProcessSyncTransport } from "../src/transports/in-process-transport.js";
import { createMemorySyncStateStore } from "./sync-test-harness/memory-sync-state.js";
import { scanForAcquirable } from "../src/acquisition-scan.js";
import { runAcquisition } from "../src/acquisition.js";
import {
  decideResidency,
  type BlobCandidate,
} from "../src/residency-policy.js";
import { blobCandidateForRecord } from "../src/sync-engine.js";
import type { ReplicaProbe } from "../src/durability.js";

const MB = 1024 * 1024;
const clock = createHLCClock({ nodeId: "node" });
const hashOf = (b: Buffer) => createHash("sha256").update(b as unknown as Uint8Array).digest("hex");
const b64Of = (b: Buffer) => createHash("sha256").update(b as unknown as Uint8Array).digest("base64");

describe("decideResidency", () => {
  const base = { constraints: { deniedHere: false } };
  it("fetches a file within the ceiling", () => {
    expect(decideResidency({ ...base, placement: "within" })).toMatchObject({
      decision: "fetch",
      reason: "within-ceiling",
    });
  });

  it("fetches a file no stand-in can replace", () => {
    expect(decideResidency({ ...base, placement: "keep" })).toMatchObject({
      decision: "fetch",
      reason: "kept",
    });
  });

  it("declines a file above the ceiling", () => {
    expect(decideResidency({ ...base, placement: "above" })).toMatchObject({
      decision: "elide",
      reason: "above-ceiling",
    });
  });

  it("lets a record constraint beat the ceiling", () => {
    expect(
      decideResidency({ ...base, placement: "keep", constraints: { deniedHere: true } }),
    ).toMatchObject({ decision: "elide", reason: "record-constraint" });
  });
});

describe("starkeep/no-cloud, evaluated against this node's identity", () => {
  type Label = { appId: string; key: string; value: string };

  function build(labels: Label[], isCloudNode: boolean): ResidencyManager {
    const adapter = {
      async getLabelsByRecordIds(ids: StarkeepId[]) {
        return new Map(ids.map((id) => [id, labels.map((l) => ({ ...l, recordId: id, deletedAt: null }))]));
      },
    } as unknown as DatabaseAdapter;
    return createResidencyManager({
      localDb: new DatabaseSync(":memory:") as never,
      databaseAdapter: adapter,
      localObjectStorage: new MockObjectStorageAdapter(),
      isCloudNode,
      ceilings: DEFAULT_SYNC_DOWN_CEILINGS.desktop,
    });
  }
  const doc: BlobCandidate = {
    recordId: "r1",
    objectStorageKey: "shared/document/aa/" + "a".repeat(64),
    sizeBytes: 1000,
    type: "document/pdf",
    parentId: null,
    appId: null,
  };
  const noCloud = [{ appId: STARKEEP_LABEL_APP_ID, key: NO_CLOUD_LABEL_KEY, value: "" }];

  it("declines on the cloud node", async () => {
    expect(await build(noCloud, true).decide(doc)).toMatchObject({
      decision: "elide",
      reason: "record-constraint",
    });
  });

  // A laptop or a phone may hold these bytes freely. Reading the label as
  // "nobody may hold this" would leave the only copy in the cloud the person
  // just forbade.
  it("does not decline on a laptop or a phone", async () => {
    expect((await build(noCloud, false).decide(doc)).decision).toBe("fetch");
  });

  // `appId` on a label row is server-set, so this is an app annotating its own
  // namespace — not the platform constraint.
  it("ignores a no-cloud label written by an app rather than the platform", async () => {
    const manager = build([{ appId: "photos", key: NO_CLOUD_LABEL_KEY, value: "" }], true);
    expect((await manager.decide(doc)).decision).toBe("fetch");
  });
});

describe("a residency manager", () => {
  let db: MockDatabaseAdapter;
  let local: MockObjectStorageAdapter;
  let cloud: MockObjectStorageAdapter;
  let manager: ResidencyManager;
  let probes: ReplicaProbe[];
  let n = 0;

  function makeManager(
    ceilings = DEFAULT_SYNC_DOWN_CEILINGS.desktop,
    borrowsBytes?: (key: string) => boolean,
    keepOriginals?: boolean,
  ): ResidencyManager {
    return createResidencyManager({
      localDb: new DatabaseSync(":memory:") as never,
      databaseAdapter: db,
      localObjectStorage: local,
      isCloudNode: false,
      ceilings,
      ...(borrowsBytes ? { borrowsBytes } : {}),
      ...(keepOriginals === undefined ? {} : { keepOriginals }),
    });
  }

  beforeEach(async () => {
    db = new MockDatabaseAdapter();
    local = new MockObjectStorageAdapter();
    cloud = new MockObjectStorageAdapter();
    await db.init();
    await local.init();
    await cloud.init();
    manager = makeManager();
    probes = [{ nodeId: "cloud", storage: cloud }];
  });

  /** A record with real bytes here, and optionally a verified copy in the cloud. */
  async function file(
    over: {
      type?: string;
      parentId?: string;
      standInRole?: StandInRole;
      fidelity?: number | null;
      size?: number;
      canonicalThreshold?: number | null;
    },
    where: { here?: boolean; cloud?: boolean } = { here: true, cloud: true },
  ): Promise<DataRecord> {
    const data = Buffer.alloc(over.size ?? 2 * MB, n++ % 251);
    data.write(`unique-${n}`);
    const hash = hashOf(data);
    const type = over.type ?? "image/jpeg";
    const key = `shared/${type.split("/")[0]}/${hash.slice(0, 2)}/${hash}`;
    const record = createDataRecord(
      {
        type,
        originAppId: "photos",
        contentHash: hash,
        objectStorageKey: key,
        sizeBytes: data.length,
        parentId: (over.parentId ?? null) as never,
        standInRole: over.standInRole ?? null,
        fidelity: over.fidelity === undefined ? null : over.fidelity,
        // An original carries the default stamp unless the case says
        // otherwise, as a node that knows the library's value writes it. An
        // unstamped original is `awaiting-stamp`, which no ceiling rule can
        // place, so leaving the stamp off would change what these cases mean.
        canonicalThreshold:
          over.canonicalThreshold !== undefined
            ? over.canonicalThreshold
            : over.standInRole || over.parentId || over.fidelity == null
              ? null
              : (standardsFor(type, DEFAULT_STAND_IN_STANDARDS)?.canonicalThreshold ?? null),
        originalFilename: `f-${n}`,
      },
      clock,
    );
    await db.put(record);
    if (where.here) {
      await local.put(key, data);
      await manager.noteArrival(blobCandidateForRecord(record)!);
    }
    if (where.cloud) await cloud.put(key, data, { checksumSha256: b64Of(data) });
    return record;
  }

  async function family(opts: { cloudCanonical?: boolean; cloudOriginal?: boolean } = {}) {
    const original = await file({ fidelity: 6000, size: 8 * MB }, { here: true, cloud: opts.cloudOriginal ?? true });
    const canonical = await file(
      { type: "image/avif", parentId: original.id, standInRole: "canonical", fidelity: 4272, size: 3 * MB },
      { here: true, cloud: opts.cloudCanonical ?? true },
    );
    const screen = await file(
      { type: "image/avif", parentId: original.id, standInRole: "smaller", fidelity: 2560, size: MB },
    );
    const medium = await file(
      { type: "image/avif", parentId: original.id, standInRole: "smaller", fidelity: 1280, size: MB / 2 },
    );
    return { original, canonical, screen, medium };
  }

  it("groups held bytes by whether a stand-in can replace them", async () => {
    const { original, screen } = await family();
    const poster = await file({ type: "image/webp", parentId: original.id, size: MB });
    const pdf = await file({ type: "document/pdf", size: MB });
    expect(manager.index.get(screen.objectStorageKey)?.group).toBe("stand-in:image");
    expect(manager.index.get(original.objectStorageKey)?.group).toBe("original:image");
    expect(manager.index.get(poster.objectStorageKey)?.group).toBe(KEPT_GROUP);
    expect(manager.index.get(pdf.objectStorageKey)?.group).toBe(KEPT_GROUP);
  });

  it("decides by the ceiling: 2560 within on a desktop, above on a phone", async () => {
    const { screen, original } = await family();
    const candidate = blobCandidateForRecord(screen)!;
    expect((await manager.decide(candidate)).reason).toBe("within-ceiling");
    const phone = makeManager(DEFAULT_SYNC_DOWN_CEILINGS.phone);
    expect((await phone.decide(candidate)).reason).toBe("above-ceiling");
    expect((await manager.decide(blobCandidateForRecord(original)!)).reason).toBe("above-ceiling");
  });

  // No stand-in can replace either, so a phone with the tightest ceiling still
  // takes both, whatever their size.
  it("applies changed ceilings to the next decision", async () => {
    const { screen } = await family();
    const candidate = blobCandidateForRecord(screen)!;
    manager.setCeilings(DEFAULT_SYNC_DOWN_CEILINGS.phone);
    expect((await manager.decide(candidate)).reason).toBe("above-ceiling");
    manager.setCeilings(DEFAULT_SYNC_DOWN_CEILINGS.desktop);
    expect((await manager.decide(candidate)).reason).toBe("within-ceiling");
  });

  it("keeps a document and a derived record on every node", async () => {
    const phone = makeManager(DEFAULT_SYNC_DOWN_CEILINGS.phone);
    const pdf = await file({ type: "document/pdf", size: 64 * MB }, { here: false, cloud: true });
    const original = await file({ fidelity: 6000 }, { here: false, cloud: true });
    const poster = await file({ type: "image/webp", parentId: original.id }, { here: false, cloud: true });
    for (const r of [pdf, poster]) {
      expect(await phone.decide(blobCandidateForRecord(r)!), r.type).toMatchObject({
        decision: "fetch",
        reason: "kept",
      });
    }
  });

  it("keeps an app's own file, which no stand-in can replace", async () => {
    const own: BlobCandidate = {
      recordId: "row",
      objectStorageKey: "apps/notes/aa/x",
      sizeBytes: 64 * MB,
      type: null,
      parentId: null,
      appId: "notes",
    };
    expect(manager.ceilingOf(own)).toBe("keep");
    expect((await manager.decide(own)).reason).toBe("kept");
  });

  describe("a node that keeps originals", () => {
    beforeEach(() => {
      manager = makeManager(DEFAULT_SYNC_DOWN_CEILINGS.phone, undefined, true);
    });

    it("receives every original, and still leaves stand-ins above the ceiling on demand", async () => {
      const original = await file({ fidelity: 6000 }, { here: false, cloud: true });
      const unmeasured = await file({ fidelity: null }, { here: false, cloud: true });
      const canonical = await file(
        { type: "image/avif", parentId: original.id, standInRole: "canonical", fidelity: 4272 },
        { here: false, cloud: true },
      );
      for (const r of [original, unmeasured]) {
        expect(await manager.decide(blobCandidateForRecord(r)!)).toMatchObject({
          decision: "fetch",
          reason: "within-ceiling",
        });
        expect(await manager.considerForAcquisition(blobCandidateForRecord(r)!)).toBe("queued");
      }
      expect((await manager.decide(blobCandidateForRecord(canonical)!)).reason).toBe("above-ceiling");
    });

    it("still counts originals as originals", async () => {
      const { original } = await family();
      expect(manager.index.get(original.objectStorageKey)?.group).toBe("original:image");
    });

    it("frees no original, and frees stand-ins above the ceiling in the wider scope", async () => {
      const { original, canonical, screen, medium } = await family();
      const narrow = await manager.freeUpSpace({ bytes: 100 * MB, scope: "originals", probes });
      expect(narrow.eligibleBytes).toBe(0);
      const wide = await manager.freeUpSpace({ bytes: 100 * MB, scope: "originals-and-above-ceiling", probes });
      expect(wide.removed.map((r) => r.recordId).sort()).toEqual([canonical.id, screen.id].sort());
      for (const r of [original, medium]) expect(await local.has(r.objectStorageKey)).toBe(true);
    });
  });

  describe("the acquisition queue", () => {
    it("queues a wanted file this node lacks, and never one above the ceiling", async () => {
      const original = await file({ fidelity: 6000 }, { here: false, cloud: true });
      const small = await file(
        { type: "image/avif", parentId: original.id, standInRole: "smaller", fidelity: 1280 },
        { here: false, cloud: true },
      );
      const pdf = await file({ type: "document/pdf" }, { here: false, cloud: true });
      expect(await manager.considerForAcquisition(blobCandidateForRecord(small)!)).toBe("queued");
      expect(await manager.considerForAcquisition(blobCandidateForRecord(pdf)!)).toBe("queued");
      expect(await manager.considerForAcquisition(blobCandidateForRecord(original)!)).toBe("unwanted");
      expect(manager.deferredCandidates(10).map((e) => e.recordId).sort()).toEqual(
        [small.id, pdf.id].sort(),
      );
    });

    it("adopts bytes already here that the index never saw", async () => {
      const data = Buffer.alloc(MB, 9);
      const hash = hashOf(data);
      const own = createDataRecord(
        {
          type: "document/pdf",
          originAppId: "drive",
          contentHash: hash,
          objectStorageKey: `shared/document/${hash.slice(0, 2)}/${hash}`,
          sizeBytes: data.length,
        },
        clock,
      );
      await db.put(own);
      await local.put(own.objectStorageKey, data);
      expect(manager.index.get(own.objectStorageKey)).toBeNull();
      expect(await manager.considerForAcquisition(blobCandidateForRecord(own)!)).toBe("held");
      expect(manager.index.get(own.objectStorageKey)).toMatchObject({ resident: true, group: KEPT_GROUP });
    });

    it("stops wanting a queued file once the node no longer wants it", async () => {
      // One node's disk under two ceilings: the desktop's queues the 2560
      // stand-in, and a lowered ceiling finds it unwanted and drops the row.
      const localDb = new DatabaseSync(":memory:") as never;
      const at = (ceilings: typeof DEFAULT_SYNC_DOWN_CEILINGS.desktop) =>
        createResidencyManager({
          localDb,
          databaseAdapter: db,
          localObjectStorage: local,
          isCloudNode: false,
          ceilings,
        });
      const original = await file({ fidelity: 6000 }, { here: false, cloud: true });
      const screen = await file(
        { type: "image/avif", parentId: original.id, standInRole: "smaller", fidelity: 2560 },
        { here: false, cloud: true },
      );
      const candidate = blobCandidateForRecord(screen)!;
      expect(await at(DEFAULT_SYNC_DOWN_CEILINGS.desktop).considerForAcquisition(candidate)).toBe("queued");
      const lowered = at(DEFAULT_SYNC_DOWN_CEILINGS.phone);
      expect(await lowered.considerForAcquisition(candidate)).toBe("unwanted");
      expect(lowered.deferredCandidates(10)).toEqual([]);
    });

    it("wants a freed file again without forgetting that it was freed", async () => {
      const { screen } = await family();
      manager.noteDeparture(screen.objectStorageKey);
      expect(manager.wasEvicted(screen.objectStorageKey)).toBe(true);
      expect(await manager.considerForAcquisition(blobCandidateForRecord(screen)!)).toBe("queued");
      expect(manager.wasEvicted(screen.objectStorageKey)).toBe(true);
      manager.dropDeferred(screen.objectStorageKey);
      expect(manager.deferredCandidates(10)).toEqual([]);
      expect(manager.wasEvicted(screen.objectStorageKey)).toBe(true);
    });
  });

  describe("freeUpSpace", () => {
    it("removes originals largest first and stops at the amount", async () => {
      const a = await family();
      const b = await family();
      const report = await manager.freeUpSpace({ bytes: 1, scope: "originals", probes });
      expect(report.removed).toHaveLength(1);
      expect(report.freedBytes).toBe(8 * MB);
      const gone = report.removed[0]!.recordId;
      expect([a.original.id, b.original.id]).toContain(gone);
      expect(report.eligibleBytes).toBe(16 * MB);
    });

    it("leaves stand-ins alone in the originals scope", async () => {
      const { canonical, screen, medium } = await family();
      await manager.freeUpSpace({ bytes: 100 * MB, scope: "originals", probes });
      for (const r of [canonical, screen, medium]) expect(await local.has(r.objectStorageKey)).toBe(true);
    });

    // No stand-in can replace either, so neither is ever eligible.
    it("never takes a document or a derived record", async () => {
      const { original } = await family();
      const pdf = await file({ type: "document/pdf", size: 64 * MB });
      const poster = await file({ type: "image/webp", parentId: original.id, size: 32 * MB });
      await manager.freeUpSpace({ bytes: 1000 * MB, scope: "originals-and-above-ceiling", probes });
      for (const r of [pdf, poster]) expect(await local.has(r.objectStorageKey), r.type).toBe(true);
    });

    it("takes stand-ins above the ceiling in the wider scope, never those within it", async () => {
      manager = makeManager(DEFAULT_SYNC_DOWN_CEILINGS.phone);
      const { original, canonical, screen, medium } = await family();
      const report = await manager.freeUpSpace({ bytes: 100 * MB, scope: "originals-and-above-ceiling", probes });
      expect(report.removed.map((r) => r.recordId).sort()).toEqual(
        [original.id, canonical.id, screen.id].sort(),
      );
      expect(await local.has(medium.objectStorageKey)).toBe(true);
      for (const r of [original, canonical, screen]) expect(await local.has(r.objectStorageKey)).toBe(false);
      expect(manager.wasEvicted(original.objectStorageKey)).toBe(true);
    });

    it("refuses an original whose canonical stand-in has no cloud copy", async () => {
      const { original } = await family({ cloudCanonical: false });
      const report = await manager.freeUpSpace({ bytes: 100 * MB, scope: "originals", probes });
      expect(report.removed).toEqual([]);
      expect(report.refused).toMatchObject([{ recordId: original.id, reason: "not-durable" }]);
      expect(await local.has(original.objectStorageKey)).toBe(true);
    });

    it("refuses an original with no cloud copy of its own", async () => {
      const { original } = await family({ cloudOriginal: false });
      const report = await manager.freeUpSpace({ bytes: 100 * MB, scope: "originals", probes });
      expect(report.refused.map((r) => r.recordId)).toEqual([original.id]);
      expect(await local.has(original.objectStorageKey)).toBe(true);
    });

    it("refuses an original with no canonical stand-in at all", async () => {
      const original = await file({ fidelity: 6000, size: 8 * MB });
      const report = await manager.freeUpSpace({ bytes: 100 * MB, scope: "originals", probes });
      expect(report.refused).toMatchObject([{ recordId: original.id, reason: "no-canonical" }]);
    });

    it("refuses without a probe", async () => {
      await family();
      const report = await manager.freeUpSpace({ bytes: 100 * MB, scope: "originals", probes: [] });
      expect(report.removed).toEqual([]);
      expect(report.refused).toHaveLength(1);
    });

    it("lets a self-canonical original above the ceiling go on its own copy's proof", async () => {
      manager = makeManager(DEFAULT_SYNC_DOWN_CEILINGS.phone);
      const own = await file({ fidelity: 2000, size: 3 * MB });
      const report = await manager.freeUpSpace({ bytes: 1, scope: "originals", probes });
      expect(report.removed.map((r) => r.recordId)).toEqual([own.id]);
    });

    it("never takes a self-canonical original within the ceiling", async () => {
      const own = await file({ fidelity: 2000, size: 3 * MB });
      const report = await manager.freeUpSpace({ bytes: 100 * MB, scope: "originals-and-above-ceiling", probes });
      expect(report.eligibleBytes).toBe(0);
      expect(await local.has(own.objectStorageKey)).toBe(true);
    });

    it("frees an original this node wrote itself, which never passed through the index", async () => {
      // Written straight to the store, the way an import on this node is: no
      // round, so no resident-set row.
      const data = Buffer.alloc(8 * MB, 7);
      const hash = hashOf(data);
      const own = createDataRecord(
        {
          type: "image/jpeg",
          originAppId: "photos",
          contentHash: hash,
          objectStorageKey: `shared/image/${hash.slice(0, 2)}/${hash}`,
          sizeBytes: data.length,
          fidelity: 6000,
        },
        clock,
      );
      await db.put(own);
      await local.put(own.objectStorageKey, data);
      await cloud.put(own.objectStorageKey, data, { checksumSha256: b64Of(data) });
      await file(
        { type: "image/avif", parentId: own.id, standInRole: "canonical", fidelity: 4272, size: MB },
        { here: false, cloud: true },
      );
      expect(manager.index.get(own.objectStorageKey)).toBeNull();

      const report = await manager.freeUpSpace({ bytes: 1, scope: "originals", probes });
      expect(report.removed.map((r) => r.recordId)).toEqual([own.id]);
      expect(await local.has(own.objectStorageKey)).toBe(false);
      expect(manager.wasEvicted(own.objectStorageKey)).toBe(true);
    });

    it("skips bytes the store only borrows, such as a phone's camera-roll alias", async () => {
      const { original } = await family();
      manager = makeManager(DEFAULT_SYNC_DOWN_CEILINGS.desktop, (key) => key === original.objectStorageKey);
      const report = await manager.freeUpSpace({ bytes: 100 * MB, scope: "originals", probes });
      // Deleting the key would drop the alias and free nothing, so the
      // original is not even eligible.
      expect(report.removed).toEqual([]);
      expect(report.eligibleBytes).toBe(0);
      expect(await local.has(original.objectStorageKey)).toBe(true);
    });

    it("proves but removes nothing on a dry run", async () => {
      const { original } = await family();
      const report = await manager.freeUpSpace({ bytes: 100 * MB, scope: "originals", probes, dryRun: true });
      expect(report).toMatchObject({ dryRun: true, freedBytes: 8 * MB });
      expect(await local.has(original.objectStorageKey)).toBe(true);
      expect(manager.wasEvicted(original.objectStorageKey)).toBe(false);
    });
  });
});

describe("a round and the acquisition pass, against a ceiling", () => {
  it("elides above the ceiling on a round, keeps everything else, and lands a raised ceiling's files", async () => {
    let time = 1000;
    const localClock = createHLCClock({ nodeId: "local", wallClockFunction: () => time++ });
    const cloudClock = createHLCClock({ nodeId: "cloud", wallClockFunction: () => time++ });
    const localDb = new MockDatabaseAdapter();
    const cloudDb = new MockDatabaseAdapter();
    const localStorage = new MockObjectStorageAdapter();
    const cloudStorage = new MockObjectStorageAdapter();
    await Promise.all([localDb.init(), cloudDb.init(), localStorage.init(), cloudStorage.init()]);

    async function cloudFile(over: Partial<Parameters<typeof createDataRecord>[0]>, fill: number): Promise<DataRecord> {
      const blob = Buffer.alloc(4096, fill);
      const hash = hashOf(blob);
      const type = over.type ?? "image/jpeg";
      const record = createDataRecord(
        {
          type,
          originAppId: "photos",
          contentHash: hash,
          objectStorageKey: `shared/${type.split("/")[0]}/${hash.slice(0, 2)}/${hash}`,
          sizeBytes: blob.length,
          originalFilename: `c-${fill}`,
          ...over,
        },
        cloudClock,
      );
      await cloudDb.put(record);
      await cloudStorage.put(record.objectStorageKey, blob, { checksumSha256: b64Of(blob) });
      return record;
    }
    const original = await cloudFile({ fidelity: 6000, sizeBytes: 8 * MB }, 1);
    const screen = await cloudFile(
      { type: "image/avif", parentId: original.id, standInRole: "smaller", fidelity: 2560 },
      2,
    );
    const medium = await cloudFile(
      { type: "image/avif", parentId: original.id, standInRole: "smaller", fidelity: 1280 },
      3,
    );
    const poster = await cloudFile({ type: "image/webp", parentId: original.id }, 4);
    const pdf = await cloudFile({ type: "document/pdf", sizeBytes: 64 * MB }, 5);

    const rawDb = new DatabaseSync(":memory:");
    const node = (ceilings: typeof DEFAULT_SYNC_DOWN_CEILINGS.phone) => {
      const manager = createResidencyManager({
        localDb: rawDb as never,
        databaseAdapter: localDb,
        localObjectStorage: localStorage,
        isCloudNode: false,
          ceilings,
      });
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
        syncState: createMemorySyncStateStore(),
        residency: residencyHooks(manager),
      });
      return { manager, engine };
    };

    const phone = node(DEFAULT_SYNC_DOWN_CEILINGS.phone);
    // Drained rather than one round: the document's size exceeds a round's
    // byte budget, so it ships alone in a later round.
    await phone.engine.sync();
    expect(await localStorage.has(medium.objectStorageKey)).toBe(true);
    expect(await localStorage.has(poster.objectStorageKey)).toBe(true);
    expect(await localStorage.has(pdf.objectStorageKey)).toBe(true);
    expect(await localStorage.has(screen.objectStorageKey)).toBe(false);
    expect(await localStorage.has(original.objectStorageKey)).toBe(false);

    // The person raises this node's ceiling. No round will offer the 2560
    // again — the watermark is past it — so the catalogue scan and the
    // acquisition pass are what bring it.
    const desktop = node(DEFAULT_SYNC_DOWN_CEILINGS.desktop);
    await scanForAcquirable({
      databaseAdapter: localDb,
      consider: (candidate) => desktop.manager.considerForAcquisition(candidate),
      cursor: null,
      maxRecords: 100,
    });
    const outcome = await runAcquisition({
      engine: desktop.engine,
      manager: desktop.manager,
      databaseAdapter: localDb,
      maxBytes: 1e9,
    });
    expect(outcome.landed).toBe(1);
    expect(await localStorage.has(screen.objectStorageKey)).toBe(true);
    expect(await localStorage.has(original.objectStorageKey)).toBe(false);
  });
});
