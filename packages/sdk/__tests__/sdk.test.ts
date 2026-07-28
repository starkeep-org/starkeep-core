import { describe, it, expect } from "vitest";
import { createDataRecord, createHLCClock } from "@starkeep/protocol-primitives";
import {
  MockDatabaseAdapter,
  MockObjectStorageAdapter,
} from "@starkeep/storage-adapter";
import { createStarkeepSdk } from "../src/sdk.js";

describe("createStarkeepSdk", () => {
  async function createTestSdk() {
    const localDatabase = new MockDatabaseAdapter();
    const localObjectStorage = new MockObjectStorageAdapter();

    const clock = createHLCClock({
      nodeId: "test-node",
      wallClockFunction: () => 1000,
    });

    const sdk = await createStarkeepSdk({
      databaseAdapter: localDatabase,
      objectStorageAdapter: localObjectStorage,
      nodeId: "test-node",
      clock,
    });
    return { sdk, localDatabase, localObjectStorage };
  }

  describe("data operations", () => {
    it("should put with file and compute content hash", async () => {
      const { sdk, localObjectStorage } = await createTestSdk();

      const fileData = Buffer.from("fake image data");
      const record = await sdk.data.putWithFile(
        { type: "image/jpeg", originAppId: "test" },
        fileData,
        "image/jpeg",
      );

      expect(record.contentHash).toBeTruthy();
      expect(record.objectStorageKey).toBeTruthy();
      expect(record.mimeType).toBe("image/jpeg");
      expect(record.sizeBytes).toBe(fileData.length);

      // Key must live under shared/<category>/... (jpg → image) so that any app
      // with read access to the category can resolve it under its own IAM
      // grants — the key MUST NOT carry the writing app's identifier.
      expect(record.objectStorageKey).toMatch(/^shared\/image\/[0-9a-f]{2}\/[0-9a-f]{64}$/);

      const stored = await localObjectStorage.get(record.objectStorageKey);
      expect(stored).not.toBeNull();
    });

    it("writes the same shared/<category> key regardless of which client wrote the file", async () => {
      const localDatabase = new MockDatabaseAdapter();
      const localObjectStorage = new MockObjectStorageAdapter();
      const clock = createHLCClock({
        nodeId: "shared",
        wallClockFunction: () => 1000,
      });
      const sdkA = await createStarkeepSdk({
        databaseAdapter: localDatabase,
        objectStorageAdapter: localObjectStorage,
        nodeId: "app-a",
        clock,
      });
      const sdkB = await createStarkeepSdk({
        databaseAdapter: localDatabase,
        objectStorageAdapter: localObjectStorage,
        nodeId: "app-b",
        clock,
      });

      const fileData = Buffer.from("shared bytes");
      const written = await sdkA.data.putWithFile(
        { type: "image/jpeg", originAppId: "test" },
        fileData,
        "image/jpeg",
      );

      const readBack = await sdkB.data.get(written.id);
      expect(readBack).not.toBeNull();
      expect(readBack!.objectStorageKey).toBe(written.objectStorageKey);
      expect(written.objectStorageKey).toMatch(/^shared\/image\//);

      const fileFromB = await localObjectStorage.get(readBack!.objectStorageKey);
      expect(fileFromB).not.toBeNull();
      expect(Buffer.from(fileFromB!.data).toString()).toBe("shared bytes");
    });

    it("should delete a record", async () => {
      const { sdk } = await createTestSdk();

      const record = await sdk.data.putWithFile(
        { type: "@test/photo", originAppId: "test" },
        Buffer.from("x"),
        "image/jpeg",
      );

      await sdk.data.delete(record.id);
      const retrieved = await sdk.data.get(record.id);
      expect(retrieved).toBeNull();
    });

    it("writes and reads a per-category metadata row", async () => {
      const { sdk } = await createTestSdk();
      const record = await sdk.data.putWithFile(
        { type: "image/jpeg", originAppId: "test" },
        Buffer.from("x"),
        "image/jpeg",
      );

      // Metadata is keyed by category (jpg → image).
      await sdk.data.putMetadata("image", {
        recordId: record.id,
        width: 800,
        height: 600,
      });

      const meta = await sdk.data.getMetadata("image", record.id);
      expect(meta).not.toBeNull();
      expect(meta!["width"]).toBe(800);
      expect(meta!["height"]).toBe(600);
    });
  });

  describe("index operations", () => {
    it("should search records", async () => {
      const { sdk } = await createTestSdk();

      await sdk.data.putWithFile(
        { type: "@test/photo", originAppId: "test" },
        Buffer.from("a"),
        "image/jpeg",
      );
      await sdk.data.putWithFile(
        { type: "@test/document", originAppId: "test" },
        Buffer.from("b"),
        "text/plain",
      );

      const result = await sdk.index.search({ types: ["@test/photo"] });
      expect(result.items.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("lifecycle", () => {
    it("should close without errors", async () => {
      const { sdk } = await createTestSdk();
      await expect(sdk.close()).resolves.toBeUndefined();
    });
  });
});

describe("label operations", () => {
  async function sdkWithRecords(count: number) {
    const localDatabase = new MockDatabaseAdapter();
    const localObjectStorage = new MockObjectStorageAdapter();
    const clock = createHLCClock({ nodeId: "test-node", wallClockFunction: () => 1000 });
    const sdk = await createStarkeepSdk({
      databaseAdapter: localDatabase,
      objectStorageAdapter: localObjectStorage,
      nodeId: "test-node",
      clock,
    });
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const r = await sdk.data.putWithFile(
        { type: "image/jpeg", originAppId: "photos" },
        Buffer.from(`bytes-${i}`),
        "image/jpeg",
      );
      ids.push(r.id);
    }
    return { sdk, ids };
  }

  it("sets a flag and a valued label, denormalizing the record type", async () => {
    const { sdk, ids } = await sdkWithRecords(1);
    await sdk.data.setLabels("alpha", [
      { recordId: ids[0] as never, key: "ocr-available" },
      { recordId: ids[0] as never, key: "quality", value: "high" },
    ]);

    const labels = (await sdk.data.getLabelsByIds([ids[0] as never])).get(ids[0] as never)!;
    expect(labels).toHaveLength(2);
    expect(labels.every((l) => l.appId === "alpha")).toBe(true);
    expect(labels.every((l) => l.recordType === "image/jpeg")).toBe(true);
    // A bare flag is the empty string — there is no null in the label model.
    expect(labels.find((l) => l.key === "ocr-available")!.value).toBe("");
  });

  it("rejects a malformed key before writing anything", async () => {
    // Whole-batch validation up front: a bad key in entry 900 must not leave
    // entries 1-899 written.
    const { sdk, ids } = await sdkWithRecords(1);
    await expect(
      sdk.data.setLabels("alpha", [
        { recordId: ids[0] as never, key: "fine" },
        { recordId: ids[0] as never, key: "Not Fine" },
      ]),
    ).rejects.toThrow(/Not Fine/);
    expect((await sdk.data.getLabelsByIds([ids[0] as never])).size).toBe(0);
  });

  it("rejects a value over the byte cap", async () => {
    const { sdk, ids } = await sdkWithRecords(1);
    await expect(
      sdk.data.setLabels("alpha", [
        { recordId: ids[0] as never, key: "k", value: "x".repeat(200) },
      ]),
    ).rejects.toThrow(/128/);
  });

  it("refuses to label a record that does not exist", async () => {
    // Nothing backs record_id with a foreign key, so this would otherwise
    // create an orphan silently.
    const { sdk } = await sdkWithRecords(0);
    await expect(
      sdk.data.setLabels("alpha", [{ recordId: "01JMISSING" as never, key: "k" }]),
    ).rejects.toThrow(/does not exist/);
  });

  it("retracts, and a retracted label stops appearing on both read paths", async () => {
    const { sdk, ids } = await sdkWithRecords(1);
    await sdk.data.setLabels("alpha", [{ recordId: ids[0] as never, key: "k" }]);
    await sdk.data.retractLabels("alpha", [{ recordId: ids[0] as never, key: "k" }]);

    expect((await sdk.data.getLabelsByIds([ids[0] as never])).size).toBe(0);
    const found = await sdk.data.findByLabel({ appId: "alpha", key: "k" });
    expect(found.records).toHaveLength(0);
  });

  it("retracting a key that was never set is a no-op, not an error", async () => {
    const { sdk, ids } = await sdkWithRecords(1);
    await expect(
      sdk.data.retractLabels("alpha", [{ recordId: ids[0] as never, key: "never-set" }]),
    ).resolves.toBeUndefined();
  });

  it("finds records by label, and pages to exhaustion", async () => {
    const { sdk, ids } = await sdkWithRecords(5);
    await sdk.data.setLabels(
      "alpha",
      ids.map((id) => ({ recordId: id as never, key: "flag" })),
    );

    const seen: string[] = [];
    let cursor: string | null = null;
    let guard = 0;
    do {
      const page: { records: Array<{ id: string }>; nextCursor: string | null } =
        await sdk.data.findByLabel({ appId: "alpha", key: "flag" }, { limit: 2, cursor: cursor ?? undefined });
      seen.push(...page.records.map((r) => r.id));
      cursor = page.nextCursor;
      expect(++guard).toBeLessThan(50);
    } while (cursor !== null);

    expect(new Set(seen)).toEqual(new Set(ids));
  });

  it("distinguishes presence from exact-value matching", async () => {
    const { sdk, ids } = await sdkWithRecords(2);
    await sdk.data.setLabels("alpha", [
      { recordId: ids[0] as never, key: "quality", value: "high" },
      { recordId: ids[1] as never, key: "quality", value: "low" },
    ]);

    const all = await sdk.data.findByLabel({ appId: "alpha", key: "quality" });
    expect(all.records).toHaveLength(2);

    const high = await sdk.data.findByLabel({ appId: "alpha", key: "quality", value: "high" });
    expect(high.records.map((r) => r.id)).toEqual([ids[0]]);
  });

  it("keeps two apps' opinions about one record separate", async () => {
    const { sdk, ids } = await sdkWithRecords(1);
    await sdk.data.setLabels("alpha", [{ recordId: ids[0] as never, key: "quality", value: "high" }]);
    await sdk.data.setLabels("gamma", [{ recordId: ids[0] as never, key: "quality", value: "low" }]);

    const labels = (await sdk.data.getLabelsByIds([ids[0] as never])).get(ids[0] as never)!;
    expect(new Set(labels.map((l) => `${l.appId}=${l.value}`))).toEqual(
      new Set(["alpha=high", "gamma=low"]),
    );
    // And a reverse query stays inside the namespace it asked for.
    const fromAlpha = await sdk.data.findByLabel({ appId: "alpha", key: "quality", value: "low" });
    expect(fromAlpha.records).toHaveLength(0);
  });

  it("emits a change event so the Drive channel gets nudged", async () => {
    const { sdk, ids } = await sdkWithRecords(1);
    const seen: string[][] = [];
    sdk.changeNotifier.subscribe((e) => {
      if (e.eventType === "local-change-recorded") seen.push([...e.recordIds]);
    });
    await sdk.data.setLabels("alpha", [{ recordId: ids[0] as never, key: "k" }]);
    expect(seen).toContainEqual([ids[0]]);
  });

  it("no-ops on an empty batch without touching the store", async () => {
    const { sdk } = await sdkWithRecords(0);
    await expect(sdk.data.setLabels("alpha", [])).resolves.toBeUndefined();
    await expect(sdk.data.retractLabels("alpha", [])).resolves.toBeUndefined();
  });
});

describe("setLabels owns the chunking", () => {
  /**
   * The 3,000-rows-per-transaction rule is the SDK's headline feature —
   * "there is no bulk/non-bulk split, the one-record case is a batch of one" —
   * and it only shows up above 3,000 rows, which no other test reaches.
   *
   * Records go in through the adapter directly rather than `putWithFile`:
   * 3,001 blob writes and hashes would make this a slow test about the wrong
   * thing.
   */
  const CHUNK = 3000;

  class CountingAdapter extends MockDatabaseAdapter {
    upsertCallSizes: number[] = [];
    retractCallSizes: number[] = [];
    queryIdListSizes: number[] = [];

    override async upsertLabels(labels: Parameters<MockDatabaseAdapter["upsertLabels"]>[0]) {
      this.upsertCallSizes.push(labels.length);
      return super.upsertLabels(labels);
    }

    override async retractLabels(rs: Parameters<MockDatabaseAdapter["retractLabels"]>[0]) {
      this.retractCallSizes.push(rs.length);
      return super.retractLabels(rs);
    }

    override async query(q: Parameters<MockDatabaseAdapter["query"]>[0]) {
      const inFilter = q.filters?.find((f) => f.operator === "in");
      if (inFilter) this.queryIdListSizes.push((inFilter.value as unknown[]).length);
      return super.query(q);
    }
  }

  async function sdkWithBareRecords(count: number) {
    const localDatabase = new CountingAdapter();
    const clock = createHLCClock({ nodeId: "test-node", wallClockFunction: () => 1000 });
    const sdk = await createStarkeepSdk({
      databaseAdapter: localDatabase,
      objectStorageAdapter: new MockObjectStorageAdapter(),
      nodeId: "test-node",
      clock,
    });
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const record = createDataRecord(
        {
          type: "image/jpeg",
          originAppId: "photos",
          contentHash: `sha256:${i}`,
          objectStorageKey: `k/${i}`,
          mimeType: "image/jpeg",
          sizeBytes: 1,
        },
        clock,
      );
      await localDatabase.put(record);
      ids.push(record.id);
    }
    // The record writes are not what is being counted.
    localDatabase.queryIdListSizes.length = 0;
    return { sdk, localDatabase, ids };
  }

  it("splits a batch over the 3,000-row transaction limit into whole chunks", async () => {
    const { sdk, localDatabase, ids } = await sdkWithBareRecords(CHUNK + 1);
    await sdk.data.setLabels(
      "alpha",
      ids.map((id) => ({ recordId: id as never, key: "faces-detected" })),
    );

    // DSQL rejects the whole transaction at 3,001 modified rows, so the
    // split has to happen below the adapter, not inside it.
    expect(localDatabase.upsertCallSizes).toEqual([CHUNK, 1]);
  });

  it("chunks the record-type lookup too — it is an IN-list of the same size", async () => {
    // The read the single-statement framing hides, and probably the dominant
    // cost of a bulk labelling job.
    const { sdk, localDatabase, ids } = await sdkWithBareRecords(CHUNK + 1);
    await sdk.data.setLabels(
      "alpha",
      ids.map((id) => ({ recordId: id as never, key: "faces-detected" })),
    );
    expect(localDatabase.queryIdListSizes).toEqual([CHUNK, 1]);
  });

  it("writes one chunk for a batch at exactly the limit", async () => {
    const { sdk, localDatabase, ids } = await sdkWithBareRecords(CHUNK);
    await sdk.data.setLabels(
      "alpha",
      ids.map((id) => ({ recordId: id as never, key: "k" })),
    );
    expect(localDatabase.upsertCallSizes).toEqual([CHUNK]);
  });

  it("gives every chunk the same HLC, so a bulk pass is one logical write", async () => {
    const { sdk, ids } = await sdkWithBareRecords(CHUNK + 1);
    await sdk.data.setLabels(
      "alpha",
      ids.map((id) => ({ recordId: id as never, key: "k" })),
    );
    const first = await sdk.data.getLabelsByIds([ids[0] as never]);
    const last = await sdk.data.getLabelsByIds([ids[CHUNK] as never]);
    expect(first.get(ids[0] as never)![0].updatedAt).toEqual(
      last.get(ids[CHUNK] as never)![0].updatedAt,
    );
  });

  it("chunks retractions on the same boundary", async () => {
    const { sdk, localDatabase, ids } = await sdkWithBareRecords(CHUNK + 1);
    await sdk.data.retractLabels(
      "alpha",
      ids.map((id) => ({ recordId: id as never, key: "k" })),
    );
    expect(localDatabase.retractCallSizes).toEqual([CHUNK, 1]);
  });

  it("collapses a repeated (record, key, value) before chunking, last write winning", async () => {
    // Postgres rejects a multi-row upsert that touches one row twice, so a
    // caller's duplicate would be a cloud-only 500 without this.
    const { sdk, localDatabase, ids } = await sdkWithBareRecords(1);
    await sdk.data.setLabels("alpha", [
      { recordId: ids[0] as never, key: "quality", value: "high" },
      { recordId: ids[0] as never, key: "quality", value: "high" },
    ]);

    expect(localDatabase.upsertCallSizes).toEqual([1]);
    const labels = (await sdk.data.getLabelsByIds([ids[0] as never])).get(ids[0] as never)!;
    expect(labels).toHaveLength(1);
  });

  it("keeps two values of one key as two rows through the whole path", async () => {
    // The dedupe tuple includes `value`; on the old three-column key this
    // collapses to one row and turns a set-valued write into a single-valued
    // one, with no error and perfectly plausible output.
    const { sdk, localDatabase, ids } = await sdkWithBareRecords(1);
    await sdk.data.setLabels("alpha", [
      { recordId: ids[0] as never, key: "face", value: "Alice" },
      { recordId: ids[0] as never, key: "face", value: "Bob" },
    ]);

    expect(localDatabase.upsertCallSizes).toEqual([2]);
    const labels = (await sdk.data.getLabelsByIds([ids[0] as never])).get(ids[0] as never)!;
    expect(labels.map((l) => l.value).sort()).toEqual(["Alice", "Bob"]);
  });

  it("replaceLabelValues makes a key hold exactly the values given", async () => {
    // How a key is *updated* now that a plain write adds: Alice kept, Bob
    // tombstoned, Carol added, atomically per record.
    const { sdk, ids } = await sdkWithBareRecords(1);
    await sdk.data.setLabels("alpha", [
      { recordId: ids[0] as never, key: "face", value: "Alice" },
      { recordId: ids[0] as never, key: "face", value: "Bob" },
    ]);
    await sdk.data.replaceLabelValues("alpha", [
      { recordId: ids[0] as never, key: "face", values: ["Alice", "Carol"] },
    ]);

    const labels = (await sdk.data.getLabelsByIds([ids[0] as never])).get(ids[0] as never)!;
    expect(labels.map((l) => l.value).sort()).toEqual(["Alice", "Carol"]);
  });

  it("replaceLabelValues with no values clears the key", async () => {
    const { sdk, ids } = await sdkWithBareRecords(1);
    await sdk.data.setLabels("alpha", [{ recordId: ids[0] as never, key: "face", value: "Alice" }]);
    await sdk.data.replaceLabelValues("alpha", [
      { recordId: ids[0] as never, key: "face", values: [] },
    ]);
    expect((await sdk.data.getLabelsByIds([ids[0] as never])).get(ids[0] as never)).toBeUndefined();
  });

  it("retracting without a value takes back every value of the key", async () => {
    const { sdk, ids } = await sdkWithBareRecords(1);
    await sdk.data.setLabels("alpha", [
      { recordId: ids[0] as never, key: "face", value: "Alice" },
      { recordId: ids[0] as never, key: "face", value: "Bob" },
      { recordId: ids[0] as never, key: "quality", value: "high" },
    ]);
    await sdk.data.retractLabels("alpha", [{ recordId: ids[0] as never, key: "face" }]);

    const labels = (await sdk.data.getLabelsByIds([ids[0] as never])).get(ids[0] as never)!;
    expect(labels.map((l) => l.key)).toEqual(["quality"]);
  });

  it("emits one change event for the whole batch, with each record once", async () => {
    const { sdk, ids } = await sdkWithBareRecords(3);
    const seen: string[][] = [];
    sdk.changeNotifier.subscribe((e) => {
      if (e.eventType === "local-change-recorded") seen.push([...e.recordIds]);
    });
    await sdk.data.setLabels("alpha", [
      { recordId: ids[0] as never, key: "a" },
      { recordId: ids[0] as never, key: "b" },
      { recordId: ids[1] as never, key: "a" },
    ]);
    expect(seen).toHaveLength(1);
    expect(seen[0].sort()).toEqual([ids[0], ids[1]].sort());
  });
});

describe("the SDK sits below the trust boundary", () => {
  it("findByLabel does no grant filtering — that is the data servers' job", async () => {
    // The SDK is a per-node facility used by the local-data-server; apps reach
    // the data plane over HTTP. `query()` does no grant filtering here either,
    // and pretending otherwise would invite a caller to rely on a check this
    // layer has no identity to make.
    const localDatabase = new MockDatabaseAdapter();
    const clock = createHLCClock({ nodeId: "test-node", wallClockFunction: () => 1000 });
    const sdk = await createStarkeepSdk({
      databaseAdapter: localDatabase,
      objectStorageAdapter: new MockObjectStorageAdapter(),
      nodeId: "test-node",
      clock,
    });

    const jpeg = await sdk.data.putWithFile(
      { type: "image/jpeg", originAppId: "photos" },
      Buffer.from("a"),
      "image/jpeg",
    );
    const png = await sdk.data.putWithFile(
      { type: "image/png", originAppId: "photos" },
      Buffer.from("b"),
      "image/png",
    );
    await sdk.data.setLabels("alpha", [
      { recordId: jpeg.id, key: "k" },
      { recordId: png.id, key: "k" },
    ]);

    const found = await sdk.data.findByLabel({ appId: "alpha", key: "k" });
    expect(found.records.map((r) => r.type).sort()).toEqual(["image/jpeg", "image/png"]);
  });
});

describe("delete cascades to labels", () => {
  it("tombstones every app's labels when the record is deleted", async () => {
    // No FK backs record_id on either backend, so nothing does this for us.
    // The cascade crosses app namespaces on purpose: the record is going
    // away, so every app's assertions about it go with it.
    const localDatabase = new MockDatabaseAdapter();
    const localObjectStorage = new MockObjectStorageAdapter();
    const clock = createHLCClock({ nodeId: "test-node", wallClockFunction: () => 1000 });
    const sdk = await createStarkeepSdk({
      databaseAdapter: localDatabase,
      objectStorageAdapter: localObjectStorage,
      nodeId: "test-node",
      clock,
    });

    const doomed = await sdk.data.putWithFile(
      { type: "image/jpeg", originAppId: "photos" },
      Buffer.from("doomed"),
      "image/jpeg",
    );
    const survivor = await sdk.data.putWithFile(
      { type: "image/jpeg", originAppId: "photos" },
      Buffer.from("survivor"),
      "image/jpeg",
    );
    await sdk.data.setLabels("alpha", [{ recordId: doomed.id, key: "k" }]);
    await sdk.data.setLabels("gamma", [{ recordId: doomed.id, key: "k" }]);
    await sdk.data.setLabels("alpha", [{ recordId: survivor.id, key: "k" }]);

    await sdk.data.delete(doomed.id);

    expect((await sdk.data.getLabelsByIds([doomed.id])).size).toBe(0);
    // Another record's labels are untouched.
    expect((await sdk.data.getLabelsByIds([survivor.id])).get(survivor.id)).toHaveLength(1);
    // And the reverse query no longer surfaces the deleted record.
    const found = await sdk.data.findByLabel({ appId: "alpha", key: "k" });
    expect(found.records.map((r) => r.id)).toEqual([survivor.id]);
  });
});
