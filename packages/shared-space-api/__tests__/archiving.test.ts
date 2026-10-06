import { describe, it, expect, beforeEach } from "vitest";
import {
  buildAccessGrants,
  createDataRecord,
  createHLCClock,
  DEFAULT_STAND_IN_STANDARDS as STD,
  standardsFor,
  type DataRecord,
  type StarkeepId,
} from "@starkeep/protocol-primitives";
import { MockDatabaseAdapter, MockObjectStorageAdapter } from "@starkeep/storage-adapter";
import {
  ARCHIVE_TAGS,
  applyArchiveEvaluation,
  archiveTriggersFor,
  evaluateArchiving,
} from "../src/stand-ins/archiving.js";
import { countBacklog, pageBacklog } from "../src/stand-ins/backlog.js";

const clock = createHLCClock({ nodeId: "cloud" });
const BIG = 8 * 1024 * 1024;

let db: MockDatabaseAdapter;
let storage: MockObjectStorageAdapter;
beforeEach(async () => {
  db = new MockDatabaseAdapter();
  storage = new MockObjectStorageAdapter();
  await db.init();
  await storage.init();
});

let n = 0;
/**
 * An original gets the default stamp unless the case says otherwise, which is
 * what a node that knows the library's value writes beside the fidelity. An
 * original with a fidelity and no stamp is `awaiting-stamp` and takes no
 * stand-in at all, so leaving the stamp off would change what every case here
 * is about; the cases that mean the unstamped state pass it explicitly.
 */
async function put(
  over: Partial<Parameters<typeof createDataRecord>[0]> & { bytes?: boolean } = {},
): Promise<DataRecord> {
  const { bytes = true, ...rest } = over;
  const hash = `hash-${n++}`;
  const key = rest.objectStorageKey ?? `shared/image/aa/${hash}`;
  const type = rest.type ?? "image/jpeg";
  const stampable = rest.parentId == null && rest.standInRole == null && rest.fidelity != null;
  const r = createDataRecord(
    {
      type: "image/jpeg",
      originAppId: "photos",
      contentHash: hash,
      objectStorageKey: key,
      sizeBytes: BIG,
      ...(stampable && !("canonicalThreshold" in rest) && standardsFor(type, STD)
        ? { canonicalThreshold: standardsFor(type, STD)!.canonicalThreshold }
        : {}),
      ...rest,
    },
    clock,
  );
  await db.put(r);
  if (bytes && !(await storage.has(key))) await storage.put(key, new Uint8Array([1]));
  return r;
}

async function canonicalFor(original: DataRecord, over: { bytes?: boolean } = {}): Promise<DataRecord> {
  return put({
    type: "image/avif",
    parentId: original.id,
    standInRole: "canonical",
    fidelity: 4272,
    sizeBytes: 900_000,
    ...over,
  });
}

async function label(recordId: StarkeepId, appId: string, key: string, retract = false): Promise<void> {
  if (retract) {
    await db.retractLabels([{ recordId, appId, key, value: "", hlc: clock.now() }]);
  } else {
    await db.upsertLabels([{ recordId, appId, key, value: "", recordType: "image/jpeg", hlc: clock.now() }]);
  }
}

const evaluate = (id: StarkeepId) => evaluateArchiving(db, storage, id, STD);

describe("evaluateArchiving", () => {
  it("archives an archivable original whose canonical stand-in is in the cloud", async () => {
    const original = await put({ fidelity: 6000 });
    await canonicalFor(original);
    expect(await evaluate(original.id)).toMatchObject({ decision: "archive", archivable: true, reasons: [] });
  });

  it("keeps an original with no canonical stand-in", async () => {
    const original = await put({ fidelity: 6000 });
    const e = await evaluate(original.id);
    expect(e).toMatchObject({ decision: "keep", archivable: true });
    expect(e.reasons.join()).toMatch(/no canonical stand-in/);
  });

  it("keeps an original whose canonical stand-in's bytes have not reached the cloud", async () => {
    const original = await put({ fidelity: 6000 });
    await canonicalFor(original, { bytes: false });
    expect((await evaluate(original.id)).reasons.join()).toMatch(/not in the cloud/);
  });

  it("keeps a self-canonical original, an original below the floor, and one with no fidelity", async () => {
    for (const over of [{ fidelity: 3000 }, { fidelity: 6000, sizeBytes: 1000 }, { fidelity: null }]) {
      const original = await put(over);
      const e = await evaluate(original.id);
      expect(e.decision).toBe("keep");
      expect(e.archivable).toBe(false);
    }
  });

  it("keeps an original a canonical encode could not shrink, and says why", async () => {
    const original = await put({ type: "video/mp4", fidelity: 3000 });
    await db.put({ ...original, selfCanonical: true });
    const e = await evaluate(original.id);
    expect(e).toMatchObject({ decision: "keep", archivable: false });
    expect(e.reasons.join()).toMatch(/no canonical stand-in could be made smaller/);
  });

  it("keeps a video below the size floor even with a canonical stand-in", async () => {
    const original = await put({ type: "video/mp4", fidelity: 4800, sizeBytes: 1000 });
    await put({ type: "video/webm", parentId: original.id, standInRole: "canonical", fidelity: 4800 });
    expect((await evaluate(original.id)).reasons.join()).toMatch(/video below the size floor/);
  });

  it("archives a video above the floor at any fidelity", async () => {
    const original = await put({ type: "video/mp4", fidelity: 2000 });
    await put({ type: "video/webm", parentId: original.id, standInRole: "canonical", fidelity: 2000 });
    expect((await evaluate(original.id)).decision).toBe("archive");
  });

  it("honours do-not-archive in any app's namespace, and names the holders", async () => {
    const original = await put({ fidelity: 6000 });
    await canonicalFor(original);
    await label(original.id, "photos", "do-not-archive");
    await label(original.id, "editor", "do-not-archive");
    const held = await evaluate(original.id);
    expect(held).toMatchObject({ decision: "keep", archivable: true, heldBy: ["editor", "photos"] });

    await label(original.id, "photos", "do-not-archive", true);
    expect((await evaluate(original.id)).heldBy).toEqual(["editor"]);
    await label(original.id, "editor", "do-not-archive", true);
    expect((await evaluate(original.id)).decision).toBe("archive");
  });

  it("keeps an original marked starkeep/no-cloud", async () => {
    const original = await put({ fidelity: 6000 });
    await canonicalFor(original);
    await label(original.id, "starkeep", "no-cloud");
    expect((await evaluate(original.id)).reasons.join()).toMatch(/no-cloud/);
  });

  it("needs every record sharing the object to agree", async () => {
    const key = "shared/image/aa/shared-bytes";
    const first = await put({ fidelity: 6000, objectStorageKey: key, originalFilename: "a.jpg" });
    const second = await put({ fidelity: 6000, objectStorageKey: key, originalFilename: "b.jpg" });
    await canonicalFor(first);
    const e = await evaluate(first.id);
    expect(e.decision).toBe("keep");
    expect(e.reasons.join()).toMatch(new RegExp(`${second.id} shares these bytes`));
    await canonicalFor(second);
    expect((await evaluate(first.id)).decision).toBe("archive");
  });

  it("keeps a deleted original and a record that is not an original", async () => {
    const original = await put({ fidelity: 6000 });
    const canonical = await canonicalFor(original);
    expect((await evaluate(canonical.id)).decision).toBe("keep");
    await db.delete(original.id, clock.now());
    expect((await evaluate(original.id)).decision).toBe("keep");
  });
});

describe("applyArchiveEvaluation", () => {
  const notArchived = { isArchived: async () => false };

  it("writes both lifecycle tags for an archive decision", async () => {
    const original = await put({ fidelity: 6000 });
    await canonicalFor(original);
    const action = await applyArchiveEvaluation(storage, await evaluate(original.id), {
      mayUntag: false,
      ...notArchived,
    });
    expect(action).toBe("tagged");
    expect(storage.tagsOf(original.objectStorageKey)).toEqual(ARCHIVE_TAGS);
  });

  it("clears the tags only when the event could have removed a condition", async () => {
    const original = await put({ fidelity: 6000 });
    await canonicalFor(original);
    await storage.setTags(original.objectStorageKey, { ...ARCHIVE_TAGS });
    await label(original.id, "photos", "do-not-archive");
    const e = await evaluate(original.id);
    expect(await applyArchiveEvaluation(storage, e, { mayUntag: false, ...notArchived })).toBe("unchanged");
    expect(storage.tagsOf(original.objectStorageKey)).toEqual(ARCHIVE_TAGS);
    expect(await applyArchiveEvaluation(storage, e, { mayUntag: true, ...notArchived })).toBe("untagged");
    expect(storage.tagsOf(original.objectStorageKey)).toEqual({});
  });

  it("never untags an object the lifecycle rule has already moved", async () => {
    const original = await put({ fidelity: 6000 });
    await storage.setTags(original.objectStorageKey, { ...ARCHIVE_TAGS });
    await label(original.id, "photos", "do-not-archive");
    const action = await applyArchiveEvaluation(storage, await evaluate(original.id), {
      mayUntag: true,
      isArchived: async () => true,
    });
    expect(action).toBe("unchanged");
  });

  it("never touches a self-canonical original", async () => {
    const original = await put({ fidelity: 3000 });
    const action = await applyArchiveEvaluation(storage, await evaluate(original.id), {
      mayUntag: true,
      ...notArchived,
    });
    expect(action).toBe("unchanged");
  });

  describe("a deleted original", () => {
    // The archive decision is not an operation on a record. The platform's whole
    // act is two object tags, and the transition is performed later by a bucket
    // lifecycle rule whose clock runs on object age with no view of any record. A
    // tag left behind after a delete fires on schedule and lands bytes nothing
    // references in Deep Archive, owing a 180-day minimum. Delete time is the only
    // moment the platform still holds the decision.

    it("clears the tags on the last record to leave the object", async () => {
      const original = await put({ fidelity: 6000 });
      await canonicalFor(original);
      await storage.setTags(original.objectStorageKey, { ...ARCHIVE_TAGS });

      await db.delete(original.id, clock.now());
      const [trigger] = archiveTriggersFor([(await db.get(original.id))!], []);
      expect(trigger).toEqual({ originalId: original.id, mayUntag: true });

      const e = await evaluate(original.id);
      // The key is kept rather than nulled, which is what used to make this case
      // report `unchanged` and write nothing.
      expect(e).toMatchObject({
        decision: "keep",
        objectStorageKey: original.objectStorageKey,
        archivable: true,
      });
      expect(await applyArchiveEvaluation(storage, e, { mayUntag: true, ...notArchived })).toBe(
        "untagged",
      );
      expect(storage.tagsOf(original.objectStorageKey)).toEqual({});
    });

    it("leaves the tags alone while a live record still shares the object", async () => {
      // Object keys name bytes, so two records holding one file under two names
      // share an object. The tag is a fact about the object, not about either record.
      const original = await put({ fidelity: 6000 });
      await canonicalFor(original);
      const sibling = await put({
        fidelity: 6000,
        objectStorageKey: original.objectStorageKey,
        originalFilename: "same-bytes-other-name.jpg",
      });
      expect(sibling.objectStorageKey).toBe(original.objectStorageKey);
      await storage.setTags(original.objectStorageKey, { ...ARCHIVE_TAGS });

      await db.delete(original.id, clock.now());
      const e = await evaluate(original.id);
      expect(e).toMatchObject({ decision: "keep", archivable: false });
      expect(await applyArchiveEvaluation(storage, e, { mayUntag: true, ...notArchived })).toBe(
        "unchanged",
      );
      expect(storage.tagsOf(original.objectStorageKey)).toEqual(ARCHIVE_TAGS);
    });

    it("leaves an object the lifecycle rule has already moved where it is", async () => {
      // The platform never thaws on its own; a restore is the person's decision.
      const original = await put({ fidelity: 6000 });
      await storage.setTags(original.objectStorageKey, { ...ARCHIVE_TAGS });
      await db.delete(original.id, clock.now());
      const action = await applyArchiveEvaluation(storage, await evaluate(original.id), {
        mayUntag: true,
        isArchived: async () => true,
      });
      expect(action).toBe("unchanged");
      expect(storage.tagsOf(original.objectStorageKey)).toEqual(ARCHIVE_TAGS);
    });
  });
});

describe("archiveTriggersFor", () => {
  it("turns canonical stand-ins, originals and do-not-archive labels into originals to re-decide", async () => {
    const original = await put({ fidelity: 6000 });
    const canonical = await canonicalFor(original);
    const small = await put({ type: "image/avif", parentId: original.id, standInRole: "smaller", fidelity: 640 });
    const other = await put({ fidelity: 6000 });
    const triggers = archiveTriggersFor(
      [canonical, small, other],
      [{ recordId: original.id, key: "do-not-archive", deletedAt: null }],
    );
    expect(triggers).toEqual([
      { originalId: original.id, mayUntag: true },
      { originalId: other.id, mayUntag: false },
    ]);
  });

  it("lets a canonical stand-in's tombstone clear a tag, and a label's retraction not", async () => {
    const original = await put({ fidelity: 6000 });
    const canonical = await canonicalFor(original);
    expect(archiveTriggersFor([{ ...canonical, deletedAt: clock.now() }], [])).toEqual([
      { originalId: original.id, mayUntag: true },
    ]);
    expect(
      archiveTriggersFor([], [{ recordId: original.id, key: "do-not-archive", deletedAt: clock.now() }]),
    ).toEqual([{ originalId: original.id, mayUntag: false }]);
  });

  it("emits a trigger for a tombstoned original, which is what takes the tag off", async () => {
    // It emitted none at all before, so a tag outlived the record it belonged to.
    const original = await put({ fidelity: 6000 });
    expect(archiveTriggersFor([{ ...original, deletedAt: clock.now() }], [])).toEqual([
      { originalId: original.id, mayUntag: true },
    ]);
  });

  it("ignores smaller stand-ins, derived records and other labels", async () => {
    const original = await put({ fidelity: 6000 });
    const small = await put({ type: "image/avif", parentId: original.id, standInRole: "smaller", fidelity: 640 });
    const poster = await put({ parentId: original.id });
    expect(archiveTriggersFor([small, poster], [{ recordId: original.id, key: "faces", deletedAt: null }])).toEqual(
      [],
    );
  });
});

describe("pageBacklog", () => {
  const grants = buildAccessGrants(
    [
      { typeId: "image/jpeg", access: "read" },
      { typeId: "video/mp4", access: "read" },
    ],
    { allAccess: false },
  );

  it("lists originals that take a canonical stand-in and have none", async () => {
    const waiting = await put({ fidelity: 6000 });
    const done = await put({ fidelity: 6000 });
    await canonicalFor(done);
    await put({ fidelity: 3000 }); // self-canonical: never waiting
    const video = await put({ type: "video/mp4", fidelity: 4800, sizeBytes: 1000 }); // below the floor, still waiting
    const page = await pageBacklog(db, grants, { kind: "missing-canonical" }, STD);
    expect(page.records.map((r) => r.id).sort()).toEqual([waiting.id, video.id].sort());
  });

  it("lists originals with no reported fidelity", async () => {
    const unknown = await put({ fidelity: null });
    await put({ fidelity: 6000 });
    const page = await pageBacklog(db, grants, { kind: "missing-fidelity" }, STD);
    expect(page.records.map((r) => r.id)).toEqual([unknown.id]);
  });

  it("keeps to the caller's readable types", async () => {
    await put({ type: "image/png", fidelity: 6000 });
    await put({ type: "audio/flac", fidelity: 900 });
    const page = await pageBacklog(db, grants, { kind: "missing-canonical" }, STD);
    expect(page.records).toEqual([]);
  });

  it("pages, and a short page still carries the cursor", async () => {
    // Three originals that need nothing and one that does. Which page the
    // waiting one lands on depends on content-addressed id order, so this
    // walks every page: the contract is "page until the cursor is null", and a
    // page cut before the filter runs can come back short or empty.
    for (let i = 0; i < 3; i++) await canonicalFor(await put({ fidelity: 6000 }));
    const last = await put({ fidelity: 6000 });

    const seen: string[] = [];
    const sizes: number[] = [];
    let cursor: string | null | undefined;
    do {
      const page = await pageBacklog(
        db,
        grants,
        { kind: "missing-canonical", limit: 2, ...(cursor ? { cursor } : {}) },
        STD,
      );
      seen.push(...page.records.map((r) => r.id));
      sizes.push(page.records.length);
      cursor = page.nextCursor;
    } while (cursor);

    expect(seen).toEqual([last.id]);
    // At least one page came back under its limit while a cursor remained,
    // which is the thing a caller must not read as "done".
    expect(sizes.slice(0, -1).some((n) => n < 2)).toBe(true);
  });
});

describe("countBacklog", () => {
  const all = buildAccessGrants([], { allAccess: true });

  it("counts originals missing a canonical stand-in across every page", async () => {
    for (let i = 0; i < 3; i++) await put({ fidelity: 6000 });
    await canonicalFor(await put({ fidelity: 6000 }));
    expect(await countBacklog(db, all, "missing-canonical", STD)).toEqual({ count: 3, complete: true });
  });

  it("counts originals with no reported fidelity", async () => {
    await put({ fidelity: null });
    await put({ fidelity: null });
    await put({ fidelity: 6000 });
    expect(await countBacklog(db, all, "missing-fidelity", STD)).toEqual({ count: 2, complete: true });
  });

  it("stops at its limit and says the count is a lower bound", async () => {
    for (let i = 0; i < 3; i++) await put({ fidelity: 6000 });
    const counted = await countBacklog(db, all, "missing-canonical", STD, { maxScanned: 2, pageSize: 1 });
    expect(counted).toEqual({ count: 2, complete: false });
  });
});
