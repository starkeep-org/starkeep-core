/**
 * The cloud refuses a synced tombstone of the canonical stand-in of an
 * archived original.
 *
 * While an original sits in deep archive, its canonical stand-in is all a
 * person can see of the photograph without a twelve-hour restore. A node that
 * deleted the stand-in alone would otherwise take that away everywhere. The
 * transport's side of the refusal — keep the live row, ship it back — is
 * covered in sync-engine's `stand-in-dedup.test.ts`; this is the rule that
 * decides when to refuse.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  createDataRecord,
  createHLCClock,
  type DataRecord,
  type StandInRole,
} from "@starkeep/protocol-primitives";
import { MockDatabaseAdapter } from "@starkeep/storage-adapter";
import { keepCanonicalOfArchivedOriginal } from "../src/stand-ins/delete.js";

const clock = createHLCClock({ nodeId: "cloud" });
let db: MockDatabaseAdapter;
let n = 0;

beforeEach(async () => {
  db = new MockDatabaseAdapter();
  await db.init();
});

async function record(over: {
  parentId?: string;
  standInRole?: StandInRole;
  fidelity?: number;
  type?: string;
  canonicalThreshold?: number;
}): Promise<DataRecord> {
  n += 1;
  const hash = String(n).padStart(64, "0");
  const r = createDataRecord(
    {
      type: over.type ?? "image/jpeg",
      originAppId: "photos",
      contentHash: hash,
      objectStorageKey: `shared/image/00/${hash}`,
      sizeBytes: 8 * 1024 * 1024,
      parentId: (over.parentId ?? null) as never,
      standInRole: over.standInRole ?? null,
      fidelity: over.fidelity ?? null,
      canonicalThreshold: over.canonicalThreshold ?? null,
    },
    clock,
  );
  await db.put(r);
  return r;
}

async function family(state: "archived" | "restoring" | "available" | null) {
  const original = await record({ fidelity: 6000, canonicalThreshold: 4272 });
  const canonical = await record({ type: "image/avif", parentId: original.id, standInRole: "canonical", fidelity: 4272 });
  const smaller = await record({ type: "image/avif", parentId: original.id, standInRole: "smaller", fidelity: 2560 });
  if (state) {
    await db.putAvailability({
      objectStorageKey: original.objectStorageKey!,
      state,
      tier: state === "available" ? null : "DEEP_ARCHIVE",
      expectedLatencyHours: state === "available" ? null : 12,
      readyAtMs: null,
      restoredUntilMs: null,
      observedAtMs: 1,
    } as never);
  }
  return { original, canonical, smaller };
}

describe("keepCanonicalOfArchivedOriginal", () => {
  it("keeps the canonical stand-in of an archived original", async () => {
    const { canonical } = await family("archived");
    expect(await keepCanonicalOfArchivedOriginal(db, canonical, { records: [] })).toBe(true);
  });

  it("keeps it while the original is being restored, which is still not readable", async () => {
    const { canonical } = await family("restoring");
    expect(await keepCanonicalOfArchivedOriginal(db, canonical, {})).toBe(true);
  });

  // A delete of the whole item: the original's own tombstone rides along.
  it("lets it go when the same exchange tombstones the original", async () => {
    const { original, canonical } = await family("archived");
    const exchange = { records: [{ id: original.id, deletedAt: clock.now() }] };
    expect(await keepCanonicalOfArchivedOriginal(db, canonical, exchange)).toBe(false);
  });

  it("does not count a live copy of the original in the exchange as its delete", async () => {
    const { original, canonical } = await family("archived");
    const exchange = { records: [{ id: original.id, deletedAt: null }] };
    expect(await keepCanonicalOfArchivedOriginal(db, canonical, exchange)).toBe(true);
  });

  it("lets it go when the original is readable, or has no availability row", async () => {
    expect(await keepCanonicalOfArchivedOriginal(db, (await family("available")).canonical, {})).toBe(false);
    expect(await keepCanonicalOfArchivedOriginal(db, (await family(null)).canonical, {})).toBe(false);
  });

  it("lets it go when the original is already deleted", async () => {
    const { original, canonical } = await family("archived");
    await db.delete(original.id, clock.now());
    expect(await keepCanonicalOfArchivedOriginal(db, canonical, {})).toBe(false);
  });

  it("keeps it however the exchange describes it, short of the original's own tombstone", async () => {
    const { canonical } = await family("archived");
    const same = { id: canonical.id, deletedAt: null };
    expect(await keepCanonicalOfArchivedOriginal(db, canonical, { records: [same] })).toBe(true);
  });

  it("never keeps a smaller stand-in, an original or an ordinary record", async () => {
    const { original, smaller } = await family("archived");
    expect(await keepCanonicalOfArchivedOriginal(db, smaller, {})).toBe(false);
    expect(await keepCanonicalOfArchivedOriginal(db, original, {})).toBe(false);
    expect(await keepCanonicalOfArchivedOriginal(db, await record({ type: "document/pdf" }), {})).toBe(false);
  });
});
