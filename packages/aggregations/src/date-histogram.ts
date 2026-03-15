import type { DateGranularity, DateHistogramBucket } from "./types.js";

export function computeDateBucket(wallTime: number, granularity: DateGranularity): string {
  const date = new Date(wallTime);

  switch (granularity) {
    case "day": {
      const year = date.getUTCFullYear();
      const month = String(date.getUTCMonth() + 1).padStart(2, "0");
      const day = String(date.getUTCDate()).padStart(2, "0");
      return `${year}-${month}-${day}`;
    }
    case "week": {
      return computeISOWeekBucket(date);
    }
    case "month": {
      const year = date.getUTCFullYear();
      const month = String(date.getUTCMonth() + 1).padStart(2, "0");
      return `${year}-${month}`;
    }
    case "year": {
      return String(date.getUTCFullYear());
    }
  }
}

function computeISOWeekBucket(date: Date): string {
  // ISO 8601 week calculation
  const utcDate = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // Set to nearest Thursday: current date + 4 - current day number (Monday=1, Sunday=7)
  const dayOfWeek = utcDate.getUTCDay() || 7;
  utcDate.setUTCDate(utcDate.getUTCDate() + 4 - dayOfWeek);
  const yearStart = new Date(Date.UTC(utcDate.getUTCFullYear(), 0, 1));
  const weekNumber = Math.ceil(((utcDate.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${utcDate.getUTCFullYear()}-W${String(weekNumber).padStart(2, "0")}`;
}

export interface DateHistogramEntry {
  readonly wallTime: number;
  readonly sizeBytes: number;
}

export function buildDateHistogram(
  entries: DateHistogramEntry[],
  granularity: DateGranularity,
): DateHistogramBucket[] {
  const bucketMap = new Map<string, { count: number; sizeBytes: number }>();

  for (const entry of entries) {
    const period = computeDateBucket(entry.wallTime, granularity);
    const existing = bucketMap.get(period);
    if (existing) {
      existing.count += 1;
      existing.sizeBytes += entry.sizeBytes;
    } else {
      bucketMap.set(period, { count: 1, sizeBytes: entry.sizeBytes });
    }
  }

  const buckets: DateHistogramBucket[] = [];
  for (const [period, data] of bucketMap) {
    buckets.push({
      period,
      count: data.count,
      sizeBytes: data.sizeBytes,
    });
  }

  buckets.sort((a, b) => a.period.localeCompare(b.period));

  return buckets;
}
