import type { StarkeepId, HLCTimestamp, DataRecord, MetadataRecord } from "@starkeep/core";
import type { Filter } from "@starkeep/storage-adapter";

export interface MetadataFilter {
  readonly targetType: string;
  readonly generatorId: string;
  readonly field: string;
  readonly operator: Filter["operator"];
  readonly value: unknown;
}

export type SyncBoundaryFilter = "sync-eligible" | "local-only" | "all";

export interface IndexQuery {
  readonly types?: string[];
  readonly dateRange?: { readonly start: HLCTimestamp; readonly end: HLCTimestamp };
  readonly metadataFilters?: MetadataFilter[];
  readonly fullTextSearch?: string;
  readonly syncBoundary?: SyncBoundaryFilter;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface IndexItem {
  readonly dataRecord: DataRecord;
  readonly metadata: Record<string, MetadataRecord>;
}

export interface IndexResult {
  readonly items: IndexItem[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

export interface SyncBoundary {
  markSyncEligible(recordId: StarkeepId): Promise<void>;
  markLocalOnly(recordId: StarkeepId): Promise<void>;
  isSyncEligible(recordId: StarkeepId): Promise<boolean>;
  getSyncEligibleIds(since?: HLCTimestamp): Promise<StarkeepId[]>;
}

export interface UnifiedIndex {
  search(query: IndexQuery): Promise<IndexResult>;
  getWithMetadata(recordId: StarkeepId): Promise<IndexItem | null>;
  readonly syncBoundary: SyncBoundary;
}
