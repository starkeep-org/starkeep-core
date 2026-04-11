import type { DataRecord, StarkeepId } from "@starkeep/core";
import type { DatabaseAdapter } from "@starkeep/storage-adapter";
import { buildDateHistogram, type DateHistogramEntry } from "./date-histogram.js";
import type {
  AggregationEngine,
  AggregationOptions,
  AggregationResult,
  DateGranularity,
} from "./types.js";

const PAGE_SIZE = 500;

export interface CreateAggregationEngineOptions {
  readonly databaseAdapter: DatabaseAdapter;
}

export function createAggregationEngine(
  engineOptions: CreateAggregationEngineOptions,
): AggregationEngine {
  const { databaseAdapter } = engineOptions;
  let cachedResult: AggregationResult | null = null;

  async function compute(options?: AggregationOptions): Promise<AggregationResult> {
    const granularity: DateGranularity = options?.dateGranularity ?? "month";
    const typeFilter = options?.types;

    let totalCount = 0;
    let totalSizeBytes = 0;
    const countsByType: Record<string, number> = {};
    const countsByMimeType: Record<string, number> = {};
    const histogramEntries: DateHistogramEntry[] = [];

    let cursor: string | undefined = undefined;
    let hasMore = true;

    while (hasMore) {
      const queryResult = await databaseAdapter.query({
        limit: PAGE_SIZE,
        cursor,
      });

      for (const record of queryResult.records) {
        const dataRecord = record as DataRecord;

        if (typeFilter && typeFilter.length > 0 && !typeFilter.includes(dataRecord.type)) {
          continue;
        }

        totalCount += 1;
        totalSizeBytes += dataRecord.sizeBytes ?? 0;

        countsByType[dataRecord.type] = (countsByType[dataRecord.type] ?? 0) + 1;

        if (dataRecord.mimeType) {
          countsByMimeType[dataRecord.mimeType] =
            (countsByMimeType[dataRecord.mimeType] ?? 0) + 1;
        }

        histogramEntries.push({
          wallTime: dataRecord.createdAt.wallTime,
          sizeBytes: dataRecord.sizeBytes ?? 0,
        });
      }

      hasMore = queryResult.hasMore;
      cursor = queryResult.nextCursor ?? undefined;
    }

    const dateHistogram = buildDateHistogram(histogramEntries, granularity);

    const result: AggregationResult = {
      totalCount,
      totalSizeBytes,
      countsByType,
      countsByMimeType,
      dateHistogram,
    };

    cachedResult = result;
    return result;
  }

  async function incrementalUpdate(
    changedRecordIds: StarkeepId[],
  ): Promise<AggregationResult> {
    if (!cachedResult) {
      return compute();
    }

    const histogramEntries: DateHistogramEntry[] = [];

    let newCount = cachedResult.totalCount;
    let newSizeBytes = cachedResult.totalSizeBytes;
    const newCountsByType = { ...cachedResult.countsByType };
    const newCountsByMimeType = { ...cachedResult.countsByMimeType };

    for (const recordId of changedRecordIds) {
      const record = await databaseAdapter.get(recordId);
      if (!record) {
        continue;
      }

      const dataRecord = record;

      newCount += 1;
      newSizeBytes += dataRecord.sizeBytes ?? 0;

      newCountsByType[dataRecord.type] = (newCountsByType[dataRecord.type] ?? 0) + 1;

      if (dataRecord.mimeType) {
        newCountsByMimeType[dataRecord.mimeType] =
          (newCountsByMimeType[dataRecord.mimeType] ?? 0) + 1;
      }

      histogramEntries.push({
        wallTime: dataRecord.createdAt.wallTime,
        sizeBytes: dataRecord.sizeBytes ?? 0,
      });
    }

    // Merge new histogram entries with existing buckets
    const existingBuckets = [...cachedResult.dateHistogram];
    const newBuckets = buildDateHistogram(histogramEntries, "month");

    const mergedBucketMap = new Map<string, { count: number; sizeBytes: number }>();
    for (const bucket of existingBuckets) {
      mergedBucketMap.set(bucket.period, {
        count: bucket.count,
        sizeBytes: bucket.sizeBytes,
      });
    }
    for (const bucket of newBuckets) {
      const existing = mergedBucketMap.get(bucket.period);
      if (existing) {
        existing.count += bucket.count;
        existing.sizeBytes += bucket.sizeBytes;
      } else {
        mergedBucketMap.set(bucket.period, {
          count: bucket.count,
          sizeBytes: bucket.sizeBytes,
        });
      }
    }

    const mergedHistogram = Array.from(mergedBucketMap.entries())
      .map(([period, data]) => ({ period, count: data.count, sizeBytes: data.sizeBytes }))
      .sort((a, b) => a.period.localeCompare(b.period));

    const result: AggregationResult = {
      totalCount: newCount,
      totalSizeBytes: newSizeBytes,
      countsByType: newCountsByType,
      countsByMimeType: newCountsByMimeType,
      dateHistogram: mergedHistogram,
    };

    cachedResult = result;
    return result;
  }

  function getCached(): AggregationResult | null {
    return cachedResult;
  }

  function invalidate(): void {
    cachedResult = null;
  }

  return {
    compute,
    incrementalUpdate,
    getCached,
    invalidate,
  };
}
