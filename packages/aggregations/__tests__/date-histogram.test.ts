import { describe, it, expect } from "vitest";
import { computeDateBucket, buildDateHistogram } from "../src/date-histogram.js";

describe("computeDateBucket", () => {
  // 2024-01-15T12:00:00Z
  const sampleTimestamp = Date.UTC(2024, 0, 15, 12, 0, 0);

  it("should return ISO date string for day granularity", () => {
    const result = computeDateBucket(sampleTimestamp, "day");
    expect(result).toBe("2024-01-15");
  });

  it("should return year-month string for month granularity", () => {
    const result = computeDateBucket(sampleTimestamp, "month");
    expect(result).toBe("2024-01");
  });

  it("should return year string for year granularity", () => {
    const result = computeDateBucket(sampleTimestamp, "year");
    expect(result).toBe("2024");
  });

  it("should return ISO week string for week granularity", () => {
    const result = computeDateBucket(sampleTimestamp, "week");
    // 2024-01-15 is a Monday, ISO week 3
    expect(result).toBe("2024-W03");
  });

  it("should handle week boundary correctly", () => {
    // 2024-01-01 is a Monday, ISO week 1
    const newYearTimestamp = Date.UTC(2024, 0, 1, 0, 0, 0);
    const result = computeDateBucket(newYearTimestamp, "week");
    expect(result).toBe("2024-W01");
  });

  it("should handle end of year correctly for day granularity", () => {
    const endOfYear = Date.UTC(2024, 11, 31, 23, 59, 59);
    const result = computeDateBucket(endOfYear, "day");
    expect(result).toBe("2024-12-31");
  });

  it("should handle different months for month granularity", () => {
    const marchTimestamp = Date.UTC(2024, 2, 5, 10, 0, 0);
    expect(computeDateBucket(marchTimestamp, "month")).toBe("2024-03");

    const decemberTimestamp = Date.UTC(2024, 11, 25, 10, 0, 0);
    expect(computeDateBucket(decemberTimestamp, "month")).toBe("2024-12");
  });
});

describe("buildDateHistogram", () => {
  it("should return empty array for empty entries", () => {
    const result = buildDateHistogram([], "month");
    expect(result).toEqual([]);
  });

  it("should group entries into a single bucket", () => {
    const entries = [
      { wallTime: Date.UTC(2024, 0, 10), sizeBytes: 100 },
      { wallTime: Date.UTC(2024, 0, 20), sizeBytes: 200 },
    ];

    const result = buildDateHistogram(entries, "month");

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      period: "2024-01",
      count: 2,
      sizeBytes: 300,
    });
  });

  it("should group entries into multiple buckets", () => {
    const entries = [
      { wallTime: Date.UTC(2024, 0, 10), sizeBytes: 100 },
      { wallTime: Date.UTC(2024, 1, 15), sizeBytes: 200 },
      { wallTime: Date.UTC(2024, 0, 25), sizeBytes: 300 },
    ];

    const result = buildDateHistogram(entries, "month");

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      period: "2024-01",
      count: 2,
      sizeBytes: 400,
    });
    expect(result[1]).toEqual({
      period: "2024-02",
      count: 1,
      sizeBytes: 200,
    });
  });

  it("should return buckets sorted by period", () => {
    const entries = [
      { wallTime: Date.UTC(2024, 5, 1), sizeBytes: 50 },
      { wallTime: Date.UTC(2024, 0, 1), sizeBytes: 100 },
      { wallTime: Date.UTC(2024, 2, 1), sizeBytes: 75 },
    ];

    const result = buildDateHistogram(entries, "month");

    expect(result.map((bucket) => bucket.period)).toEqual([
      "2024-01",
      "2024-03",
      "2024-06",
    ]);
  });

  it("should work with day granularity", () => {
    const entries = [
      { wallTime: Date.UTC(2024, 0, 15, 10, 0, 0), sizeBytes: 100 },
      { wallTime: Date.UTC(2024, 0, 15, 14, 0, 0), sizeBytes: 200 },
      { wallTime: Date.UTC(2024, 0, 16, 10, 0, 0), sizeBytes: 150 },
    ];

    const result = buildDateHistogram(entries, "day");

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      period: "2024-01-15",
      count: 2,
      sizeBytes: 300,
    });
    expect(result[1]).toEqual({
      period: "2024-01-16",
      count: 1,
      sizeBytes: 150,
    });
  });

  it("should work with year granularity", () => {
    const entries = [
      { wallTime: Date.UTC(2023, 5, 1), sizeBytes: 100 },
      { wallTime: Date.UTC(2024, 0, 1), sizeBytes: 200 },
      { wallTime: Date.UTC(2024, 6, 1), sizeBytes: 300 },
    ];

    const result = buildDateHistogram(entries, "year");

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ period: "2023", count: 1, sizeBytes: 100 });
    expect(result[1]).toEqual({ period: "2024", count: 2, sizeBytes: 500 });
  });
});
