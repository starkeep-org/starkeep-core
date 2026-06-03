import type { StarkeepId } from "@starkeep/protocol-primitives";

export type DateGranularity = "day" | "week" | "month" | "year";

export interface DateHistogramBucket {
  readonly period: string;
  readonly count: number;
  readonly sizeBytes: number;
}

export interface AggregationResult {
  readonly totalCount: number;
  readonly totalSizeBytes: number;
  readonly countsByType: Record<string, number>;
  readonly countsByMimeType: Record<string, number>;
  readonly dateHistogram: DateHistogramBucket[];
}

export interface AggregationOptions {
  readonly types?: string[];
  readonly dateGranularity?: DateGranularity;
}

export interface AggregationEngine {
  compute(options?: AggregationOptions): Promise<AggregationResult>;
  incrementalUpdate(changedRecordIds: StarkeepId[]): Promise<AggregationResult>;
  getCached(): AggregationResult | null;
  invalidate(): void;
}
