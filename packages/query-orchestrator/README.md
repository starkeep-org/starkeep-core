# @starkeep/query-orchestrator

Unified query orchestrator that joins data records with their metadata and manages sync boundaries for selective synchronization.

## Installation

```bash
pnpm add @starkeep/query-orchestrator
```

## Usage

```ts
import { createUnifiedIndex } from "@starkeep/query-orchestrator";

const unifiedIndex = createUnifiedIndex({
  databaseAdapter: myDatabaseAdapter,
});

// Search with filters across data and metadata
const searchResult = await unifiedIndex.search({
  types: ["photo"],
  metadataFilters: [
    { generatorId: "image-dimensions", field: "width", operator: "gte", value: 1920 },
  ],
  limit: 50,
});

for (const item of searchResult.items) {
  console.log(item.dataRecord.id, item.metadata);
}

// Fetch a single record with all its metadata
const singleItem = await unifiedIndex.getWithMetadata(recordId);

// Manage sync boundaries
await unifiedIndex.syncBoundary.markSyncEligible(recordId);
const eligibleIds = await unifiedIndex.syncBoundary.getSyncEligibleIds();
```

## API

### Factory Functions

| Function | Description |
|---|---|
| `createUnifiedIndex(options)` | Creates a `UnifiedIndex` with search and sync boundary support |
| `createSyncBoundary(databaseAdapter)` | Creates a standalone `SyncBoundary` instance |
| `planQuery(query, databaseAdapter)` | Translates an `IndexQuery` into planned database queries |

### `UnifiedIndex`

| Method | Description |
|---|---|
| `search(query)` | Query data records with optional metadata filters, date ranges, full-text search, and pagination |
| `getWithMetadata(recordId)` | Retrieve a single data record alongside all its metadata |
| `syncBoundary` | Access the `SyncBoundary` for marking records as sync-eligible or local-only |

### `SyncBoundary`

| Method | Description |
|---|---|
| `markSyncEligible(recordId)` | Mark a record for synchronization |
| `markLocalOnly(recordId)` | Mark a record as local-only (excluded from sync) |
| `isSyncEligible(recordId)` | Check whether a record is eligible for sync |
| `getSyncEligibleIds(since?)` | List all sync-eligible record IDs, optionally since a given timestamp |

### Key Types

| Type | Description |
|---|---|
| `IndexQuery` | Query parameters: types, date range, metadata filters, full-text search, sync boundary, pagination |
| `IndexItem` | A data record paired with its metadata map |
| `IndexResult` | Paginated search result with items, cursor, and `hasMore` flag |
| `MetadataFilter` | Filter on a specific metadata generator's field |
| `SyncBoundaryFilter` | `"sync-eligible"`, `"local-only"`, or `"all"` |

## Testing

```bash
pnpm --filter @starkeep/query-orchestrator test
```
