import { describe, it, expect, beforeEach } from "vitest";
import {
  buildAccessGrants,
  createDataRecord,
  createHLCClock,
  DEFAULT_STAND_IN_STANDARDS as STD,
  type DataRecord,
} from "@starkeep/protocol-primitives";
import { MockDatabaseAdapter } from "@starkeep/storage-adapter";
import {
  awaitsStamp,
  markSelfCanonical,
  planStandInWrite,
  planOriginalFidelity,
  reconcileReportedFidelity,
  recordOriginalFidelity,
  retireReplacedStandIns,
  stampUnstampedOriginals,
} from "../src/stand-ins/write.js";

const clock = createHLCClock({ nodeId: "test" });
const grants = buildAccessGrants(
  [
    { typeId: "image/jpeg", access: "readwrite", metadataWrite: true },
    { typeId: "image/avif", access: "readwrite", metadataWrite: true },
  ],
  { allAccess: false },
);

let db: MockDatabaseAdapter;
beforeEach(async () => {
  db = new MockDatabaseAdapter();
  await db.init();
});

async function put(over: Partial<Parameters<typeof createDataRecord>[0]> & { hash: string }): Promise<DataRecord> {
  const { hash, ...rest } = over;
  const r = createDataRecord(
    {
      type: "image/jpeg",
      originAppId: "a",
      contentHash: hash,
      objectStorageKey: `shared/image/aa/${hash}`,
      sizeBytes: 8 * 1024 * 1024,
      ...rest,
    },
    clock,
  );
  await db.put(r);
  return r;
}

describe("planStandInWrite", () => {
  it("plans an accepted stand-in", async () => {
    const parent = await put({ hash: "o", fidelity: 6000 });
    const plan = await planStandInWrite(
      db,
      grants,
      { type: "image/avif", parentId: parent.id, standIn: { role: "smaller", fidelity: 640 } },
      STD,
      true,
    );
    expect(plan).toMatchObject({ ok: true, role: "smaller", fidelity: 640, recordParentFidelity: null });
  });

  it("passes the reported parent fidelity through for the caller to record", async () => {
    const parent = await put({ hash: "o" });
    const plan = await planStandInWrite(
      db,
      grants,
      { type: "image/avif", parentId: parent.id, standIn: { role: "smaller", fidelity: 640 }, parentFidelity: 5000 },
      STD,
      true,
    );
    expect(plan).toMatchObject({ ok: true, recordParentFidelity: 5000 });
  });

  it("refuses a malformed standIn field", async () => {
    const plan = await planStandInWrite(db, grants, { type: "image/avif", parentId: "x", standIn: "canonical" }, STD, true);
    expect(plan).toMatchObject({ ok: false, status: 400, body: { code: "invalid-stand-in" } });
  });

  it("hides an original the caller cannot read", async () => {
    const parent = await put({ hash: "o", fidelity: 6000, type: "image/png" });
    const plan = await planStandInWrite(
      db,
      grants,
      { type: "image/avif", parentId: parent.id, standIn: { role: "smaller", fidelity: 640 } },
      STD,
      true,
    );
    expect(plan).toMatchObject({ ok: false, status: 404, body: { code: "parent-not-found" } });
  });

  it("names the occupant of a taken smaller slot", async () => {
    const parent = await put({ hash: "o", fidelity: 6000 });
    const occupant = await put({
      hash: "s",
      type: "image/avif",
      parentId: parent.id,
      standInRole: "smaller",
      fidelity: 640,
    });
    const plan = await planStandInWrite(
      db,
      grants,
      { type: "image/avif", parentId: parent.id, standIn: { role: "smaller", fidelity: 640 } },
      STD,
      true,
    );
    expect(plan).toMatchObject({ ok: false, status: 409, body: { error: "StandInExists", existing: occupant.id } });
  });

  it("names the occupant of a taken canonical slot", async () => {
    const parent = await put({ hash: "o", fidelity: 6000 });
    const occupant = await put({
      hash: "c",
      type: "image/avif",
      parentId: parent.id,
      standInRole: "canonical",
      fidelity: 4272,
    });
    const plan = await planStandInWrite(
      db,
      grants,
      { type: "image/avif", parentId: parent.id, standIn: { role: "canonical", fidelity: 4272 } },
      STD,
      true,
    );
    expect(plan).toMatchObject({ ok: false, status: 409, body: { existing: occupant.id } });
  });

  it("measures a smaller stand-in against the existing canonical stand-in", async () => {
    const parent = await put({ hash: "o", fidelity: 6000 });
    await put({ hash: "c", type: "image/avif", parentId: parent.id, standInRole: "canonical", fidelity: 2000 });
    const plan = await planStandInWrite(
      db,
      grants,
      { type: "image/avif", parentId: parent.id, standIn: { role: "smaller", fidelity: 2560 } },
      STD,
      true,
    );
    expect(plan).toMatchObject({ ok: false, status: 400, body: { code: "exceeds-canonical" } });
  });

  it("ignores a tombstoned occupant", async () => {
    const parent = await put({ hash: "o", fidelity: 6000 });
    const gone = await put({ hash: "s", type: "image/avif", parentId: parent.id, standInRole: "smaller", fidelity: 640 });
    await db.delete(gone.id, clock.now());
    const plan = await planStandInWrite(
      db,
      grants,
      { type: "image/avif", parentId: parent.id, standIn: { role: "smaller", fidelity: 640 } },
      STD,
      true,
    );
    expect(plan.ok).toBe(true);
  });
});

describe("replacing a canonical stand-in", () => {
  const canonicalWrite = (parentId: string, fidelity: number, sizeBytes = 1000) =>
    planStandInWrite(
      db,
      grants,
      { type: "image/avif", parentId, standIn: { role: "canonical", fidelity }, sizeBytes },
      STD,
      true,
    );

  it("retires an outdated canonical stand-in and the smaller ones at or above the new one", async () => {
    // Stamped at 2560 after a canonical stand-in was made at the old 4272.
    const parent = await put({ hash: "o", fidelity: 6000, canonicalThreshold: 2560 });
    const old = await put({ hash: "c", type: "image/avif", parentId: parent.id, standInRole: "canonical", fidelity: 4272 });
    const at = await put({ hash: "s1", type: "image/avif", parentId: parent.id, standInRole: "smaller", fidelity: 2560 });
    const below = await put({ hash: "s2", type: "image/avif", parentId: parent.id, standInRole: "smaller", fidelity: 1280 });

    const plan = await canonicalWrite(parent.id, 2560);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.retire.map((r) => r.id).sort()).toEqual([old.id, at.id].sort());
    expect(plan.selfCanonical).toBe(false);

    await retireReplacedStandIns(db, plan, clock);
    expect((await db.get(old.id))!.deletedAt).not.toBeNull();
    expect((await db.get(at.id))!.deletedAt).not.toBeNull();
    expect((await db.get(below.id))!.deletedAt).toBeNull();
  });

  it("answers StandInExists for a matching canonical stand-in, and retires nothing", async () => {
    const parent = await put({ hash: "o", fidelity: 6000, canonicalThreshold: 4272 });
    const current = await put({ hash: "c", type: "image/avif", parentId: parent.id, standInRole: "canonical", fidelity: 4272 });
    const plan = await canonicalWrite(parent.id, 4272);
    expect(plan).toMatchObject({ ok: false, status: 409, body: { error: "StandInExists", existing: current.id } });
  });

  it("marks the original self-canonical for a canonical stand-in no smaller than it", async () => {
    const parent = await put({ hash: "o", type: "video/mp4", fidelity: 3000, canonicalThreshold: 4800 });
    const videoGrants = buildAccessGrants(
      [
        { typeId: "video/mp4", access: "readwrite", metadataWrite: true },
        { typeId: "video/webm", access: "readwrite", metadataWrite: true },
      ],
      { allAccess: false },
    );
    const plan = await planStandInWrite(
      db,
      videoGrants,
      {
        type: "video/webm",
        parentId: parent.id,
        standIn: { role: "canonical", fidelity: 3000 },
        sizeBytes: parent.sizeBytes,
      },
      STD,
      true,
    );
    expect(plan).toMatchObject({ ok: true, selfCanonical: true, retire: [] });
    if (!plan.ok) return;
    const marked = await markSelfCanonical(db, plan, clock);
    expect(marked).toMatchObject({ selfCanonical: true, fidelity: 3000, version: parent.version + 1 });
    expect((await db.get(parent.id))!.selfCanonical).toBe(true);

    // From now on the original takes no canonical stand-in at all.
    const again = await planStandInWrite(
      db,
      videoGrants,
      { type: "video/webm", parentId: parent.id, standIn: { role: "canonical", fidelity: 3000 }, sizeBytes: 10 },
      STD,
      true,
    );
    expect(again).toMatchObject({ ok: false, status: 409, body: { code: "original-takes-no-canonical" } });
  });

  it("stamps a parent whose fidelity it records with the library's value", async () => {
    const parent = await put({ hash: "o" });
    const known = await planStandInWrite(
      db,
      grants,
      { type: "image/avif", parentId: parent.id, standIn: { role: "smaller", fidelity: 640 }, parentFidelity: 6000 },
      STD,
      true,
    );
    expect(known).toMatchObject({ ok: true, recordParentFidelity: 6000, parentStamp: 4272 });
  });

  it("refuses a stand-in for an unstamped parent, and keeps the fidelity the write reported", async () => {
    const parent = await put({ hash: "o" });
    // A node holding no settings file: it cannot stamp, so nothing here knows
    // what threshold the original is judged by, and no stand-in for it can be
    // checked. The reported fidelity is kept all the same, so the cloud can
    // stamp the original and the caller's retry can succeed.
    const plan = await planStandInWrite(
      db,
      grants,
      { type: "image/avif", parentId: parent.id, standIn: { role: "smaller", fidelity: 640 }, parentFidelity: 6000 },
      STD,
      false,
    );
    expect(plan).toMatchObject({
      ok: false,
      status: 409,
      body: { code: "parent-awaits-stamp" },
      recordFidelityFirst: { fidelity: 6000 },
    });
    expect((plan as { recordFidelityFirst: { parent: { id: string } } }).recordFidelityFirst.parent.id).toBe(
      parent.id,
    );
  });

  it("accepts a canonical stand-in for an unstamped parent once the same write stamps it", async () => {
    // The ordinary path on a node that does know the library's value: one write
    // records the fidelity, the stamp and the stand-in together.
    const parent = await put({ hash: "o" });
    const plan = await planStandInWrite(
      db,
      grants,
      {
        type: "image/avif",
        parentId: parent.id,
        standIn: { role: "canonical", fidelity: 4272 },
        parentFidelity: 6000,
      },
      STD,
      true,
    );
    expect(plan).toMatchObject({ ok: true, recordParentFidelity: 6000, parentStamp: 4272 });
  });
});

describe("planOriginalFidelity and reconcileReportedFidelity", () => {
  it("passes an absent fidelity as null", () => {
    expect(planOriginalFidelity({ type: "image/jpeg", parentId: null, fidelity: undefined })).toEqual({
      ok: true,
      fidelity: null,
    });
  });

  it("writes a fidelity onto a record without one, and nothing onto an agreeing one", () => {
    expect(reconcileReportedFidelity({ fidelity: null }, 3000)).toEqual({ ok: true, write: 3000 });
    expect(reconcileReportedFidelity({ fidelity: 3000 }, 3000)).toEqual({ ok: true, write: null });
    expect(reconcileReportedFidelity({ fidelity: 3000 }, null)).toEqual({ ok: true, write: null });
  });

  it("refuses a disagreeing fidelity", () => {
    expect(reconcileReportedFidelity({ fidelity: 3000 }, 3001)).toMatchObject({ ok: false, status: 409 });
  });
});

describe("recordOriginalFidelity", () => {
  it("writes the fidelity under a fresh clock and keeps the origin", async () => {
    const parent = await put({ hash: "o", originAppId: "drive" });
    const updated = await recordOriginalFidelity(db, parent, 5000, clock, 4272);
    const back = await db.get(parent.id);
    expect(back).toMatchObject({
      fidelity: 5000,
      canonicalThreshold: 4272,
      originAppId: "drive",
      version: parent.version + 1,
    });
    expect(updated.updatedAt.wallTime >= parent.updatedAt.wallTime).toBe(true);
    expect(back!.updatedAt).toEqual(updated.updatedAt);
  });
});

describe("awaitsStamp and stampUnstampedOriginals", () => {
  it("picks out the live originals that carry a fidelity and no stamp", async () => {
    const waiting = await put({ hash: "w", fidelity: 6000 });
    expect(awaitsStamp(waiting)).toBe(true);
    expect(awaitsStamp(await put({ hash: "s", fidelity: 6000, canonicalThreshold: 4272 }))).toBe(false);
    expect(awaitsStamp(await put({ hash: "u" }))).toBe(false);
    expect(awaitsStamp(await put({ hash: "d", type: "document/pdf", fidelity: null }))).toBe(false);
    expect(
      awaitsStamp(
        await put({ hash: "si", type: "image/avif", parentId: waiting.id, standInRole: "smaller", fidelity: 640 }),
      ),
    ).toBe(false);
    expect(awaitsStamp({ ...waiting, deletedAt: clock.now() })).toBe(false);
  });

  it("stamps each one with the library's value under a fresh clock", async () => {
    // The cloud's half of the stamping rule: a node that did not know the
    // library's value recorded the fidelity with a null stamp, and the cloud,
    // which always knows, fills it in when it applies the row. The fresh clock
    // is what puts the stamped row above the sender's watermark, so the same
    // exchange's reply carries it back.
    const waiting = await put({ hash: "w", fidelity: 6000, originAppId: "drive" });
    const video = await put({ hash: "v", type: "video/mp4", fidelity: 9000 });
    const already = await put({ hash: "s", fidelity: 6000, canonicalThreshold: 2560 });

    const stamped = await stampUnstampedOriginals(db, [waiting, video, already], STD, clock);

    expect(stamped.map((r) => r.id).sort()).toEqual([video.id, waiting.id].sort());
    expect(await db.get(waiting.id)).toMatchObject({
      canonicalThreshold: 4272,
      originAppId: "drive",
      version: waiting.version + 1,
    });
    expect(await db.get(video.id)).toMatchObject({ canonicalThreshold: 4800 });
    // Already stamped: left exactly as it was, whatever the library says now.
    expect(await db.get(already.id)).toMatchObject({ canonicalThreshold: 2560, version: already.version });
    expect(stamped[0]!.updatedAt.wallTime >= waiting.updatedAt.wallTime).toBe(true);
  });

  it("leaves an original another write stamped or tombstoned since the row was applied", async () => {
    // The applied row is a snapshot; the store may have moved on, so each
    // stamp re-reads before it writes.
    const applied = await put({ hash: "w", fidelity: 6000 });
    await recordOriginalFidelity(db, applied, 6000, clock, 2560);
    const gone = await put({ hash: "g", fidelity: 6000 });
    await db.delete(gone.id, clock.now());

    expect(await stampUnstampedOriginals(db, [applied, gone], STD, clock)).toEqual([]);
    expect(await db.get(applied.id)).toMatchObject({ canonicalThreshold: 2560 });
  });
});
