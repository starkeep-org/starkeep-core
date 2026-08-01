/**
 * `loadVariantsForPage` against a real database.
 *
 * The pure resolution is covered in protocol-primitives. What this covers is
 * the gathering: which children count as candidates, where their dimensions
 * come from, and the cases where a naive version quietly resolves to the wrong
 * child — a crop, a tombstoned rendition, another record's variant.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createHLCClock,
  createDataRecord,
  type CreateDataRecordInput,
  type StarkeepId,
} from "@starkeep/protocol-primitives";
import { loadVariantsForPage } from "@starkeep/storage-adapter";
import { SqliteDatabaseAdapter } from "../src/adapter.js";

const RENDITION = { appId: "photos", key: "rendition" };

describe("loadVariantsForPage", () => {
  let adapter: SqliteDatabaseAdapter;
  let tick = 1000;
  const clock = createHLCClock({ nodeId: "test", wallClockFunction: () => tick++ });

  beforeEach(async () => {
    adapter = new SqliteDatabaseAdapter({ path: ":memory:" });
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

  /** A derived child of `parent`, labelled as a rendition, with dimensions. */
  async function addVariant(
    parent: StarkeepId,
    width: number,
    height: number,
    value = "someclass",
  ): Promise<StarkeepId> {
    const id = await addRecord({ parentId: parent, type: "image/avif" });
    await label(id, RENDITION.appId, RENDITION.key, value);
    await adapter.putMetadata("image", { recordId: id, width, height });
    return id;
  }

  it("resolves each requested size against a record's variants", async () => {
    const parent = await addRecord();
    const small = await addVariant(parent, 400, 300);
    const large = await addVariant(parent, 2560, 1920);

    const out = await loadVariantsForPage(adapter, [{ id: parent }], RENDITION, [400, 2000]);
    expect(out.get(parent)!["400"]!.id).toBe(small);
    expect(out.get(parent)!["2000"]!.id).toBe(large);
  });

  it("keeps each record's variants to itself", async () => {
    const a = await addRecord();
    const b = await addRecord();
    const aVariant = await addVariant(a, 400, 300);
    await addVariant(b, 400, 300);

    const out = await loadVariantsForPage(adapter, [{ id: a }], RENDITION, [400]);
    expect(out.get(a)!["400"]!.id).toBe(aVariant);
  });

  it("resolves a whole page in one pass", async () => {
    const parents = [await addRecord(), await addRecord(), await addRecord()];
    for (const p of parents) await addVariant(p, 400, 300);

    const out = await loadVariantsForPage(
      adapter,
      parents.map((id) => ({ id })),
      RENDITION,
      [400],
    );
    expect(out.size).toBe(3);
  });

  // A crop has a parent too. Serving someone's crop when they asked for a
  // 400 px tile is the bug that reading `parent_id` alone always had.
  it("ignores children that are not labelled as variants", async () => {
    const parent = await addRecord();
    const crop = await addRecord({ parentId: parent, type: "image/jpeg" });
    await label(crop, "photos", "crop");
    await adapter.putMetadata("image", { recordId: crop, width: 400, height: 400 });

    const out = await loadVariantsForPage(adapter, [{ id: parent }], RENDITION, [400]);
    expect(out.get(parent)).toBeUndefined();
  });

  // A retracted rendition label means the record is no longer a rendition.
  // Continuing to serve it would serve bytes the app has disowned.
  it("ignores a variant whose label has been retracted", async () => {
    const parent = await addRecord();
    const v = await addVariant(parent, 400, 300);
    await adapter.retractLabels([
      { recordId: v, appId: RENDITION.appId, key: RENDITION.key, hlc: clock.now() },
    ]);

    const out = await loadVariantsForPage(adapter, [{ id: parent }], RENDITION, [400]);
    expect(out.get(parent)).toBeUndefined();
  });

  it("ignores a soft-deleted variant", async () => {
    const parent = await addRecord();
    const gone = await addVariant(parent, 400, 300);
    const live = await addVariant(parent, 1280, 960);
    await adapter.delete(gone, clock.now());

    const out = await loadVariantsForPage(adapter, [{ id: parent }], RENDITION, [400]);
    // Rule 2 clamps to the largest that exists — which is now the 1280.
    expect(out.get(parent)!["400"]!.id).toBe(live);
  });

  // Namespaces exist so two apps can use one key name for different things.
  it("is scoped to the naming app", async () => {
    const parent = await addRecord();
    const v = await addRecord({ parentId: parent, type: "image/avif" });
    await label(v, "otherapp", "rendition", "someclass");
    await adapter.putMetadata("image", { recordId: v, width: 400, height: 300 });

    const out = await loadVariantsForPage(adapter, [{ id: parent }], RENDITION, [400]);
    expect(out.get(parent)).toBeUndefined();
  });

  // Dimensions come from the metadata table, which may not have been written
  // yet. "Largest that exists" is meaningless over a set you cannot order.
  it("omits a record whose variants have no dimensions recorded", async () => {
    const parent = await addRecord();
    const v = await addRecord({ parentId: parent, type: "image/avif" });
    await label(v, RENDITION.appId, RENDITION.key, "someclass");
    // No putMetadata call — nothing has measured it.

    const out = await loadVariantsForPage(adapter, [{ id: parent }], RENDITION, [400]);
    expect(out.get(parent)).toBeUndefined();
  });

  it("resolves from the measured variants when only some are measured", async () => {
    const parent = await addRecord();
    const measured = await addVariant(parent, 1280, 960);
    const unmeasured = await addRecord({ parentId: parent, type: "image/avif" });
    await label(unmeasured, RENDITION.appId, RENDITION.key, "someclass");

    const out = await loadVariantsForPage(adapter, [{ id: parent }], RENDITION, [400]);
    expect(out.get(parent)!["400"]!.id).toBe(measured);
  });

  it("returns nothing for a record with no children at all", async () => {
    const parent = await addRecord();
    const out = await loadVariantsForPage(adapter, [{ id: parent }], RENDITION, [400]);
    expect(out.size).toBe(0);
  });

  it("does no work when nothing was asked for", async () => {
    const parent = await addRecord();
    await addVariant(parent, 400, 300);
    expect((await loadVariantsForPage(adapter, [{ id: parent }], RENDITION, [])).size).toBe(0);
    expect((await loadVariantsForPage(adapter, [], RENDITION, [400])).size).toBe(0);
  });

  // Rule 3, at the gathering layer: the parent is never among the candidates,
  // so no request however large can resolve to the original.
  it("never resolves to the parent record itself", async () => {
    const parent = await addRecord();
    const only = await addVariant(parent, 400, 300);

    const out = await loadVariantsForPage(adapter, [{ id: parent }], RENDITION, [1_000_000]);
    expect(out.get(parent)!["1000000"]!.id).toBe(only);
    expect(out.get(parent)!["1000000"]!.id).not.toBe(parent);
  });
});
