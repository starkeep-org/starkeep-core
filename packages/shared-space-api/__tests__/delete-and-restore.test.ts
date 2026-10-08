/**
 * Deleting a record and taking the delete back.
 *
 * Nothing is destroyed at delete time any more, so a delete is reversible for as
 * long as the retention window lasts, and restore is the mirror image of the
 * delete down to the cascade order. What is pinned here is what makes that mirror
 * exact rather than approximate: the metadata row survives, the rows restored are
 * the rows one delete took, and a label an app withdrew beforehand stays withdrawn.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  createDataRecord,
  createHLCClock,
  serializeHLC,
  type DataRecord,
  type StarkeepId,
} from "@starkeep/protocol-primitives";
import { MockDatabaseAdapter } from "@starkeep/storage-adapter";
import {
  applyRecordDelete,
  applyRecordRestore,
  planRecordDelete,
  planRecordRestore,
} from "../src/stand-ins/delete.js";

const clock = createHLCClock({ nodeId: "node-a" });
let db: MockDatabaseAdapter;
let n = 0;

beforeEach(async () => {
  db = new MockDatabaseAdapter();
  await db.init();
});

async function put(
  over: {
    type?: string;
    parentId?: string;
    standInRole?: "canonical" | "smaller";
    fidelity?: number;
  } = {},
): Promise<DataRecord> {
  const hash = `hash-${n++}`;
  const record = createDataRecord(
    {
      type: over.type ?? "image/jpeg",
      originAppId: "photos",
      contentHash: hash,
      objectStorageKey: `shared/image/aa/${hash}`,
      sizeBytes: 8 * 1024 * 1024,
      originalFilename: `f-${n}.jpg`,
      ...(over.parentId ? { parentId: over.parentId as StarkeepId } : {}),
      ...(over.standInRole ? { standInRole: over.standInRole } : {}),
      ...(over.fidelity !== undefined ? { fidelity: over.fidelity, canonicalThreshold: 4272 } : {}),
    },
    clock,
  );
  await db.put(record);
  return record;
}

/** An original with a canonical stand-in, a smaller stand-in and a poster frame. */
async function family() {
  const original = await put({ fidelity: 6000 });
  const canonical = await put({
    type: "image/avif",
    parentId: original.id,
    standInRole: "canonical",
    fidelity: 4272,
  });
  const smaller = await put({
    type: "image/avif",
    parentId: original.id,
    standInRole: "smaller",
    fidelity: 640,
  });
  const poster = await put({ parentId: original.id });
  return { original, canonical, smaller, poster };
}

async function label(record: DataRecord, key: string): Promise<void> {
  await db.upsertLabels([
    {
      recordId: record.id as StarkeepId,
      appId: "photos",
      key,
      value: "",
      recordType: record.type,
      hlc: clock.now(),
    },
  ]);
}

async function liveLabelKeys(record: DataRecord): Promise<string[]> {
  const byRecord = await db.getLabelsByRecordIds([record.id as StarkeepId]);
  return (byRecord.get(record.id as StarkeepId) ?? [])
    .filter((l) => !l.deletedAt)
    .map((l) => l.key)
    .sort();
}

async function del(record: DataRecord): Promise<DataRecord[]> {
  const plan = await planRecordDelete(db, record);
  if (!plan.ok) throw new Error(String(plan.body.error));
  return applyRecordDelete(db, plan, clock);
}

async function restore(id: string): Promise<DataRecord[]> {
  const record = (await db.get(id as StarkeepId))!;
  const plan = await planRecordRestore(db, record);
  if (!plan.ok) throw new Error(String(plan.body.error));
  return applyRecordRestore(db, plan, clock);
}

describe("applyRecordDelete", () => {
  it("tombstones the metadata row rather than destroying it", async () => {
    // The one thing a delete used to hard-delete, and it made restore permanently
    // incomplete: dimensions and a ThumbHash are reported by an app over the bytes,
    // and the platform cannot re-derive either — deriving needs the bytes and an
    // app's decoder, which is why metadata is reported rather than computed.
    const original = await put({ fidelity: 6000 });
    await db.putMetadata("image/jpeg", { recordId: original.id, width: 4032, height: 3024 });
    await del(original);
    expect(await db.getMetadata("image", original.id)).toMatchObject({ width: 4032, height: 3024 });
  });

  it("keeps the deleted record out of a metadata query", async () => {
    // The gate the hard delete was standing in for. `GET /data/metadata/:category`
    // reads the table directly, with no view of any record, so nothing else could
    // tell it the record is gone.
    const original = await put({ fidelity: 6000 });
    await db.putMetadata("image/jpeg", { recordId: original.id, width: 4032 });
    expect(await metadataQueryIds()).toEqual([original.id]);
    await del(original);
    expect(await metadataQueryIds()).toEqual([]);
    await restore(original.id);
    expect(await metadataQueryIds()).toEqual([original.id]);
  });
});

describe("planRecordRestore", () => {
  it("refuses a record that is not deleted", async () => {
    // A 409 rather than a quiet success: a Trash view offering restore on a live
    // record is a view reading a stale page, and the person should be told.
    const original = await put({ fidelity: 6000 });
    const plan = await planRecordRestore(db, original);
    expect(plan).toMatchObject({ ok: false, status: 409 });
  });

  it("refuses a stand-in whose slot a live sibling already holds", async () => {
    // The record is the first row a restore writes, so the plan's answer for it is
    // the write's answer. Refusing here gives the caller a verdict rather than an
    // empty result.
    const original = await put({ fidelity: 6000 });
    const first = await put({
      type: "image/avif",
      parentId: original.id,
      standInRole: "smaller",
      fidelity: 640,
    });
    await del(first);
    await put({ type: "image/webp", parentId: original.id, standInRole: "smaller", fidelity: 640 });

    const plan = await planRecordRestore(db, (await db.get(first.id as StarkeepId))!);
    expect(plan).toMatchObject({ ok: false, status: 409, body: { error: "SlotTaken" } });
  });

  it("takes every tombstoned child, since the delete leaves no shared stamp", async () => {
    // The delete takes its own clock reading per row, so the rows keep distinct
    // positions in the per-node order the sync scan walks — which means there is no
    // shared stamp a restore could select on. A child the person deleted on its own
    // earlier therefore comes back with the original, which is the honest reading of
    // "restore this item".
    const { original, canonical, smaller, poster } = await family();
    await del(smaller);
    await del(original);

    const tombstoned = (await db.get(original.id as StarkeepId))!;
    const plan = await planRecordRestore(db, tombstoned);
    if (!plan.ok) throw new Error("expected a plan");
    expect(plan.cascade.map((r) => r.id).sort()).toEqual(
      [canonical.id, smaller.id, poster.id].sort(),
    );
  });

  it("leaves a stand-in whose slot a live sibling already holds", async () => {
    // A stand-in that lost its slot to another was tombstoned on purpose. Restoring
    // it would put two stand-ins in one slot, which the uniqueness index on both SQL
    // backends refuses — so the restore would fail outright rather than quietly.
    const original = await put({ fidelity: 6000 });
    const loser = await put({
      type: "image/avif",
      parentId: original.id,
      standInRole: "canonical",
      fidelity: 4272,
    });
    const hlc = clock.now();
    await db.delete(loser.id as StarkeepId, hlc);
    const winner = await put({
      type: "image/webp",
      parentId: original.id,
      standInRole: "canonical",
      fidelity: 4272,
    });

    await del(original);
    // The winner's slot is taken by nothing now — both are tombstoned — so restoring
    // the original brings the winner back first, and the loser is then refused.
    const tombstoned = (await db.get(original.id as StarkeepId))!;
    const plan = await planRecordRestore(db, tombstoned);
    if (!plan.ok) throw new Error("expected a plan");
    // Both are offered, because at plan time both are tombstoned and the slot looks
    // free to either. The guard is answered per row as the restore writes.
    expect(plan.cascade.map((r) => r.id).sort()).toEqual([loser.id, winner.id].sort());
    await applyRecordRestore(db, plan, clock);
    const live = await db.query({
      filters: [
        { field: "parentId", operator: "eq", value: original.id },
        { field: "standInRole", operator: "eq", value: "canonical" },
        { field: "deletedAt", operator: "isNull" },
      ],
      limit: 10,
    });
    expect(live.records).toHaveLength(1);
  });
});

describe("applyRecordRestore", () => {
  it("brings the original and its cascade back, original first", async () => {
    // The delete goes children-first so no peer applying rows in clock order holds a
    // live stand-in whose original is gone. The restore reverses it for the same
    // reason read the other way round.
    const { original, canonical, smaller, poster } = await family();
    await del(original);
    const restored = await restore(original.id);

    expect(restored[0]!.id).toBe(original.id);
    expect(restored.map((r) => r.id).slice(1).sort()).toEqual(
      [canonical.id, smaller.id, poster.id].sort(),
    );
    for (const r of [original, canonical, smaller, poster]) {
      expect((await db.get(r.id as StarkeepId))!.deletedAt).toBeNull();
    }
  });

  it("advances the version rather than writing the old one back", async () => {
    // A restore is a revision of the record, not a return to a previous one. Writing
    // the old version back would let a peer's tombstone win the comparison and
    // delete the record again.
    const original = await put({ fidelity: 6000 });
    await del(original);
    const stored = (await db.get(original.id as StarkeepId))!;
    const [restored] = await restore(original.id);
    expect(restored!.version).toBe(stored.version + 1);
    expect(serializeHLC(restored!.updatedAt) > serializeHLC(stored.updatedAt!)).toBe(true);
  });

  it("brings the metadata row back on every record in the cascade", async () => {
    const { original, canonical } = await family();
    await db.putMetadata("image/jpeg", { recordId: original.id, width: 4032 });
    await db.putMetadata("image/avif", { recordId: canonical.id, width: 4272 });
    await del(original);
    expect(await metadataQueryIds()).toEqual([]);

    await restore(original.id);
    // Both rows live in the image category's table — `image/avif` is an image too —
    // so a restore that lifted only the original's stamp would show here as one id.
    expect((await metadataQueryIds()).sort()).toEqual([canonical.id, original.id].sort());
    expect(await db.getMetadata("image", canonical.id)).toMatchObject({ width: 4272 });
  });

  it("lifts the labels the delete retracted, and no others", async () => {
    // `tombstoneLabelsForRecord` stamps every *live* label with the deletion's own
    // clock reading, so the rows it touched are precisely the rows carrying that
    // reading. A restore that cleared every tombstone on the record would also
    // un-retract an assertion an app had deliberately withdrawn beforehand.
    const original = await put({ fidelity: 6000 });
    await label(original, "favourite");
    await label(original, "hidden");
    await db.retractLabels([
      { recordId: original.id as StarkeepId, appId: "photos", key: "hidden", value: "", hlc: clock.now() },
    ]);
    expect(await liveLabelKeys(original)).toEqual(["favourite"]);

    await del(original);
    expect(await liveLabelKeys(original)).toEqual([]);
    await restore(original.id);
    expect(await liveLabelKeys(original)).toEqual(["favourite"]);
  });

  it("gives a canonical stand-in its slot back", async () => {
    // `delete` clears the stand-in slot, which is what frees it. A restore writes the
    // full row through `put`, which recomputes the slot — so the stand-in comes home
    // with one rather than without.
    const { original, canonical } = await family();
    await del(original);
    await restore(original.id);
    const back = (await db.get(canonical.id as StarkeepId))!;
    expect(back.deletedAt).toBeNull();
    expect(back.standInRole).toBe("canonical");
  });
});

/** The record ids a metadata query over one category returns. */
async function metadataQueryIds(category = "image"): Promise<string[]> {
  const result = await db.queryShared(
    { kind: "metadata", category: category as "image" },
    {
      mode: "rows",
      table: `record_${category}_metadata`,
      select: ["record_id"],
      where: [],
      order: [],
      limit: 50,
      pageToken: null,
      include: [],
    },
  );
  if (result.mode !== "rows") throw new Error("expected rows");
  return result.rows.map((r) => String(r["record_id"]));
}
