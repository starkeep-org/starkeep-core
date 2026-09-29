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
  planStandInWrite,
  planOriginalFidelity,
  reconcileReportedFidelity,
  recordOriginalFidelity,
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
    );
    expect(plan).toMatchObject({ ok: true, recordParentFidelity: 5000 });
  });

  it("refuses a malformed standIn field", async () => {
    const plan = await planStandInWrite(db, grants, { type: "image/avif", parentId: "x", standIn: "canonical" }, STD);
    expect(plan).toMatchObject({ ok: false, status: 400, body: { code: "invalid-stand-in" } });
  });

  it("hides an original the caller cannot read", async () => {
    const parent = await put({ hash: "o", fidelity: 6000, type: "image/png" });
    const plan = await planStandInWrite(
      db,
      grants,
      { type: "image/avif", parentId: parent.id, standIn: { role: "smaller", fidelity: 640 } },
      STD,
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
    );
    expect(plan.ok).toBe(true);
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
    const updated = await recordOriginalFidelity(db, parent, 5000, clock);
    const back = await db.get(parent.id);
    expect(back).toMatchObject({ fidelity: 5000, originAppId: "drive", version: parent.version + 1 });
    expect(updated.updatedAt.wallTime >= parent.updatedAt.wallTime).toBe(true);
    expect(back!.updatedAt).toEqual(updated.updatedAt);
  });
});
