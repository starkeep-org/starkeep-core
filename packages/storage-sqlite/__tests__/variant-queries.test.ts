/**
 * `loadVariantCandidatesForPage` against a real database.
 *
 * Which children count as derived candidates, where their dimensions come
 * from, and the cases where a naive version quietly lists the wrong child — a
 * crop, a tombstoned derived record, another record's child.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createHLCClock,
  createDataRecord,
  type CreateDataRecordInput,
  type StarkeepId,
} from "@starkeep/protocol-primitives";
import { loadVariantCandidatesForPage } from "@starkeep/storage-adapter";
import { SqliteDatabaseAdapter } from "../src/adapter.js";
import { nodeSqliteDriver } from "../src/node-driver.js";

const DERIVED = { appId: "photos", key: "derived" };

describe("loadVariantCandidatesForPage", () => {
  let adapter: SqliteDatabaseAdapter;
  let tick = 1000;
  const clock = createHLCClock({ nodeId: "test", wallClockFunction: () => tick++ });

  beforeEach(async () => {
    adapter = new SqliteDatabaseAdapter({ path: ":memory:", driver: nodeSqliteDriver });
    await adapter.init();
  });

  afterEach(async () => {
    await adapter.close();
  });

  async function addRecord(over: Partial<CreateDataRecordInput> = {}): Promise<StarkeepId> {
    const record = createDataRecord(
      {
        type: "image/jpeg",
        originAppId: "photos",
        contentHash: `sha256:${Math.random().toString(36).slice(2)}`,
        objectStorageKey: `shared/image/ab/${Math.random().toString(36).slice(2)}`,
        mimeType: "image/jpeg",
        sizeBytes: 1024,
        ...over,
      },
      clock,
    );
    await adapter.put(record);
    return record.id;
  }

  async function label(recordId: StarkeepId, appId: string, key: string, value = "") {
    await adapter.upsertLabels([
      { recordId, appId, key, value, recordType: "image/jpeg", hlc: clock.now() },
    ]);
  }

  /** A derived child of `parent`, labelled as derived, with dimensions. */
  async function addVariant(
    parent: StarkeepId,
    width: number,
    height: number,
    value = "someclass",
  ): Promise<StarkeepId> {
    const id = await addRecord({ parentId: parent, type: "image/avif" });
    await label(id, DERIVED.appId, DERIVED.key, value);
    await adapter.putMetadata("image/jpeg", { recordId: id, width, height });
    return id;
  }

  const load = (ids: StarkeepId[]) =>
    loadVariantCandidatesForPage(adapter, ids.map((id) => ({ id })), DERIVED);
  const idsOf = async (parent: StarkeepId) =>
    ((await load([parent])).get(parent) ?? []).map((c) => c.id).sort();

  it("lists each derived child with its dimensions and label value", async () => {
    const parent = await addRecord();
    const child = await addVariant(parent, 1280, 720, "video-poster-720p");
    const out = await load([parent]);
    expect(out.get(parent)).toEqual([
      expect.objectContaining({ id: child, labelValue: "video-poster-720p", width: 1280, height: 720 }),
    ]);
  });

  it("keeps each record's children to itself", async () => {
    const a = await addRecord();
    const b = await addRecord();
    const aChild = await addVariant(a, 400, 300);
    await addVariant(b, 400, 300);
    expect(await idsOf(a)).toEqual([aChild]);
  });

  it("answers a whole page in one pass", async () => {
    const parents = [await addRecord(), await addRecord(), await addRecord()];
    for (const p of parents) await addVariant(p, 400, 300);
    expect((await load(parents)).size).toBe(3);
  });

  // A crop has a parent too. Offering someone's crop as a poster is the bug
  // that reading `parent_id` alone always had.
  it("ignores children that do not carry the label", async () => {
    const parent = await addRecord();
    const crop = await addRecord({ parentId: parent, type: "image/jpeg" });
    await label(crop, "photos", "crop");
    expect(await idsOf(parent)).toEqual([]);
  });

  // A retracted label means the record is no longer derived. Continuing to
  // offer it would serve bytes the app has disowned.
  it("ignores a child whose label has been retracted", async () => {
    const parent = await addRecord();
    const v = await addVariant(parent, 400, 300);
    await adapter.retractLabels([{ recordId: v, appId: DERIVED.appId, key: DERIVED.key, hlc: clock.now() }]);
    expect(await idsOf(parent)).toEqual([]);
  });

  it("ignores a soft-deleted child", async () => {
    const parent = await addRecord();
    const gone = await addVariant(parent, 400, 300);
    const live = await addVariant(parent, 1280, 960);
    await adapter.delete(gone, clock.now());
    expect(await idsOf(parent)).toEqual([live]);
  });

  // Namespaces exist so two apps can use one key name for different things.
  it("is scoped to the naming app", async () => {
    const parent = await addRecord();
    const v = await addRecord({ parentId: parent, type: "image/avif" });
    await label(v, "otherapp", "derived", "someclass");
    expect(await idsOf(parent)).toEqual([]);
  });

  // Dimensions come from the metadata table, which may not have been written
  // yet. The child is still listed, with its dimensions unknown.
  it("lists a child nothing has measured, with null dimensions", async () => {
    const parent = await addRecord();
    const v = await addRecord({ parentId: parent, type: "image/avif" });
    await label(v, DERIVED.appId, DERIVED.key, "someclass");
    expect((await load([parent])).get(parent)).toEqual([
      expect.objectContaining({ id: v, width: null, height: null }),
    ]);
  });

  it("returns nothing for a record with no children, or for an empty page", async () => {
    const parent = await addRecord();
    expect((await load([parent])).size).toBe(0);
    expect((await load([])).size).toBe(0);
  });

  // The parent is never among the candidates.
  it("never lists the parent record itself", async () => {
    const parent = await addRecord();
    await addVariant(parent, 400, 300);
    expect(await idsOf(parent)).not.toContain(parent);
  });
});
