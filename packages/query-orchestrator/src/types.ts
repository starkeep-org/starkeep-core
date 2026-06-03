import type { StarkeepId, HLCTimestamp, DataRecord } from "@starkeep/protocol-primitives";

export interface IndexQuery {
  readonly types?: string[];
  readonly dateRange?: { readonly start: HLCTimestamp; readonly end: HLCTimestamp };
  readonly fullTextSearch?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface IndexItem {
  readonly dataRecord: DataRecord;
}

export interface IndexResult {
  readonly items: IndexItem[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

export interface UnifiedIndex {
  search(query: IndexQuery): Promise<IndexResult>;
  getWithMetadata(recordId: StarkeepId): Promise<IndexItem | null>;
}
