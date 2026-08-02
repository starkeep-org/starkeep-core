/**
 * `excludeLabel` — the negated filter that lets a grid page originals
 * server-side.
 *
 * A negated filter cannot be a {@link Filter}: those constrain columns on the
 * records row, and this is an anti-join against the labels table. The cases
 * below are the ones where a naive implementation (a LEFT JOIN … IS NULL, or a
 * NOT EXISTS that forgets tombstones) silently returns the wrong set.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createHLCClock,
  createDataRecord,
  type CreateDataRecordInput,
  type StarkeepId,
} from "@starkeep/protocol-primitives";
import { SqliteDatabaseAdapter } from "../src/adapter.js";
import { nodeSqliteDriver } from "../src/node-driver.js";

function baseInput(over: Partial<CreateDataRecordInput> = {}): CreateDataRecordInput {
  return {
    type: "image/jpeg",
    originAppId: "photos",
    contentHash: `sha256:${Math.random().toString(36).slice(2)}`,
    objectStorageKey: `shared/image/ab/${Math.random().toString(36).slice(2)}`,
    mimeType: "image/jpeg",
    sizeBytes: 1024,
    ...over,
  };
}

describe("excludeLabel", () => {
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
    const record = createDataRecord(baseInput(over), clock);
    await adapter.put(record);
    return record.id;
  }

  async function label(recordId: StarkeepId, appId: string, key: string, value = "") {
    await adapter.upsertLabels([
      { recordId, appId, key, value, recordType: "image/jpeg", hlc: clock.now() },
    ]);
  }

  async function idsExcluding(appId: string, key: string): Promise<StarkeepId[]> {
    const result = await adapter.query({ excludeLabel: { appId, key } });
    return result.records.map((r) => r.id);
  }

  it("returns records that carry no such label", async () => {
    const plain = await addRecord();
    const derived = await addRecord();
    await label(derived, "photos", "rendition", "image-thumb");

    expect(await idsExcluding("photos", "rendition")).toEqual([plain]);
  });

  it("excludes regardless of the label's value", async () => {
    const a = await addRecord();
    const b = await addRecord();
    await label(a, "photos", "rendition", "image-thumb");
    await label(b, "photos", "rendition", "image-large");

    expect(await idsExcluding("photos", "rendition")).toEqual([]);
  });

  // A record can carry several values of one key. A LEFT JOIN … IS NULL would
  // multiply the record's row before the null test, so a record holding one
  // rendition label and three face labels would come back three times.
  it("returns a record exactly once when it holds many other labels", async () => {
    const id = await addRecord();
    await label(id, "photos", "faces", "Alice");
    await label(id, "photos", "faces", "Bob");
    await label(id, "photos", "faces", "Carol");

    expect(await idsExcluding("photos", "rendition")).toEqual([id]);
  });

  // A retracted rendition label means the record is no longer a rendition.
  // Treating the dead row as live would hide it from the grid permanently, and
  // nothing would ever un-hide it.
  it("does not exclude on a tombstoned label", async () => {
    const id = await addRecord();
    await label(id, "photos", "rendition", "image-thumb");
    expect(await idsExcluding("photos", "rendition")).toEqual([]);

    await adapter.retractLabels([
      { recordId: id, appId: "photos", key: "rendition", value: "image-thumb", hlc: clock.now() },
    ]);
    expect(await idsExcluding("photos", "rendition")).toEqual([id]);
  });

  // Namespaces exist so two apps can use the same key name for different
  // things. Excluding on the key alone would let one app's vocabulary hide
  // another app's records.
  it("is scoped to the naming app", async () => {
    const id = await addRecord();
    await label(id, "otherapp", "rendition", "whatever");

    expect(await idsExcluding("photos", "rendition")).toEqual([id]);
  });

  it("combines with ordinary column filters", async () => {
    const parent = await addRecord();
    const child = await addRecord({ parentId: parent });
    await label(child, "photos", "rendition", "image-thumb");
    const crop = await addRecord({ parentId: parent });
    await label(crop, "photos", "crop");

    // Children of `parent` that are not renditions — i.e. the crop.
    const result = await adapter.query({
      filters: [{ field: "parentId", operator: "eq", value: parent }],
      excludeLabel: { appId: "photos", key: "rendition" },
    });
    expect(result.records.map((r) => r.id)).toEqual([crop]);
  });
});

describe("parentId filtering", () => {
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

  it("selects a record's children, and only that record's", async () => {
    const p1 = createDataRecord(baseInput(), clock);
    const p2 = createDataRecord(baseInput(), clock);
    await adapter.put(p1);
    await adapter.put(p2);
    const c1 = createDataRecord(baseInput({ parentId: p1.id }), clock);
    const c2 = createDataRecord(baseInput({ parentId: p2.id }), clock);
    await adapter.put(c1);
    await adapter.put(c2);

    const result = await adapter.query({
      filters: [{ field: "parentId", operator: "eq", value: p1.id }],
    });
    expect(result.records.map((r) => r.id)).toEqual([c1.id]);
  });

  // "Originals only" for a grid: everything with no parent at all.
  it("selects top-level records with isNull", async () => {
    const parent = createDataRecord(baseInput(), clock);
    await adapter.put(parent);
    await adapter.put(createDataRecord(baseInput({ parentId: parent.id }), clock));

    const result = await adapter.query({
      filters: [{ field: "parentId", operator: "isNull" }],
    });
    expect(result.records.map((r) => r.id)).toEqual([parent.id]);
  });
});
