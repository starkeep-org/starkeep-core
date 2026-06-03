import { describe, it, expect, beforeEach } from "vitest";
import { createHLCClock, createDataRecord } from "@starkeep/protocol-primitives";
import { MockDatabaseAdapter } from "@starkeep/storage-adapter";
import { createAggregationEngine } from "../src/aggregation-engine.js";

describe("createAggregationEngine", () => {
  let databaseAdapter: MockDatabaseAdapter;
  let wallTimeCounter: number;

  beforeEach(() => {
    databaseAdapter = new MockDatabaseAdapter();
    wallTimeCounter = Date.UTC(2024, 0, 15, 12, 0, 0);
  });

  function createClock(wallTime?: number) {
    const time = wallTime ?? wallTimeCounter;
    return createHLCClock({
      nodeId: "test-node",
      wallClockFunction: () => time,
    });
  }

  async function insertDataRecord(options: {
    type: string;
    mimeType?: string;
    sizeBytes?: number;
    wallTime?: number;
  }) {
    const clock = createClock(options.wallTime);
    const record = createDataRecord(
      {
        type: options.type,
        ownerId: "test-owner",
        originAppId: "test",
        mimeType: options.mimeType ?? null,
        sizeBytes: options.sizeBytes ?? null,
      },
      clock,
    );
    await databaseAdapter.put(record);
    return record;
  }

  it("should return correct counts for empty database", async () => {
    const engine = createAggregationEngine({ databaseAdapter });
    const result = await engine.compute();

    expect(result.totalCount).toBe(0);
    expect(result.totalSizeBytes).toBe(0);
    expect(result.countsByType).toEqual({});
    expect(result.countsByMimeType).toEqual({});
    expect(result.dateHistogram).toEqual([]);
  });

  it("should compute correct aggregations for several data records", async () => {
    await insertDataRecord({
      type: "@test/photo",
      mimeType: "image/jpeg",
      sizeBytes: 1024,
    });
    await insertDataRecord({
      type: "@test/photo",
      mimeType: "image/jpeg",
      sizeBytes: 2048,
    });
    await insertDataRecord({
      type: "@test/document",
      mimeType: "text/plain",
      sizeBytes: 512,
    });

    const engine = createAggregationEngine({ databaseAdapter });
    const result = await engine.compute();

    expect(result.totalCount).toBe(3);
    expect(result.totalSizeBytes).toBe(3584);
    expect(result.countsByType).toEqual({
      "@test/photo": 2,
      "@test/document": 1,
    });
    expect(result.countsByMimeType).toEqual({
      "image/jpeg": 2,
      "text/plain": 1,
    });
  });

  it("should compute date histogram with correct buckets", async () => {
    const januaryTime = Date.UTC(2024, 0, 10, 12, 0, 0);
    const februaryTime = Date.UTC(2024, 1, 15, 12, 0, 0);

    await insertDataRecord({
      type: "@test/photo",
      mimeType: "image/jpeg",
      sizeBytes: 1000,
      wallTime: januaryTime,
    });
    await insertDataRecord({
      type: "@test/photo",
      mimeType: "image/jpeg",
      sizeBytes: 2000,
      wallTime: januaryTime + 1,
    });
    await insertDataRecord({
      type: "@test/document",
      mimeType: "text/plain",
      sizeBytes: 500,
      wallTime: februaryTime,
    });

    const engine = createAggregationEngine({ databaseAdapter });
    const result = await engine.compute({ dateGranularity: "month" });

    expect(result.dateHistogram).toHaveLength(2);
    expect(result.dateHistogram[0]).toEqual({
      period: "2024-01",
      count: 2,
      sizeBytes: 3000,
    });
    expect(result.dateHistogram[1]).toEqual({
      period: "2024-02",
      count: 1,
      sizeBytes: 500,
    });
  });

  it("should return null from getCached before compute", () => {
    const engine = createAggregationEngine({ databaseAdapter });
    expect(engine.getCached()).toBeNull();
  });

  it("should return cached result after compute", async () => {
    await insertDataRecord({
      type: "@test/photo",
      mimeType: "image/jpeg",
      sizeBytes: 1024,
    });

    const engine = createAggregationEngine({ databaseAdapter });
    const computedResult = await engine.compute();
    const cachedResult = engine.getCached();

    expect(cachedResult).not.toBeNull();
    expect(cachedResult).toEqual(computedResult);
  });

  it("should clear the cache on invalidate", async () => {
    await insertDataRecord({
      type: "@test/photo",
      mimeType: "image/jpeg",
      sizeBytes: 1024,
    });

    const engine = createAggregationEngine({ databaseAdapter });
    await engine.compute();
    expect(engine.getCached()).not.toBeNull();

    engine.invalidate();
    expect(engine.getCached()).toBeNull();
  });

  it("should adjust cached counts on incrementalUpdate", async () => {
    const januaryTime = Date.UTC(2024, 0, 10, 12, 0, 0);

    await insertDataRecord({
      type: "@test/photo",
      mimeType: "image/jpeg",
      sizeBytes: 1000,
      wallTime: januaryTime,
    });

    const engine = createAggregationEngine({ databaseAdapter });
    await engine.compute({ dateGranularity: "month" });

    // Add a new record and do an incremental update
    const newRecord = await insertDataRecord({
      type: "@test/document",
      mimeType: "text/plain",
      sizeBytes: 500,
      wallTime: januaryTime + 1,
    });

    const updatedResult = await engine.incrementalUpdate([newRecord.id]);

    expect(updatedResult.totalCount).toBe(2);
    expect(updatedResult.totalSizeBytes).toBe(1500);
    expect(updatedResult.countsByType).toEqual({
      "@test/photo": 1,
      "@test/document": 1,
    });
    expect(updatedResult.countsByMimeType).toEqual({
      "image/jpeg": 1,
      "text/plain": 1,
    });
    expect(updatedResult.dateHistogram).toHaveLength(1);
    expect(updatedResult.dateHistogram[0].count).toBe(2);
    expect(updatedResult.dateHistogram[0].sizeBytes).toBe(1500);
  });

  it("should call compute when incrementalUpdate has no cache", async () => {
    await insertDataRecord({
      type: "@test/photo",
      mimeType: "image/jpeg",
      sizeBytes: 1024,
    });

    const engine = createAggregationEngine({ databaseAdapter });

    // No compute() called beforehand, so incrementalUpdate should trigger full compute
    const result = await engine.incrementalUpdate(["nonexistent-id"]);

    expect(result.totalCount).toBe(1);
    expect(result.totalSizeBytes).toBe(1024);
  });

  it("should handle records without mimeType or sizeBytes", async () => {
    await insertDataRecord({
      type: "@test/note",
    });

    const engine = createAggregationEngine({ databaseAdapter });
    const result = await engine.compute();

    expect(result.totalCount).toBe(1);
    expect(result.totalSizeBytes).toBe(0);
    expect(result.countsByType).toEqual({ "@test/note": 1 });
    expect(result.countsByMimeType).toEqual({});
  });
});
