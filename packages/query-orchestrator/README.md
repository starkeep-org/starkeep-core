# @starkeep/query-orchestrator

Search shared data records via a thin orchestrator over the storage adapter. Today's surface covers type filtering, a `createdAt` date range, and cursor pagination; metadata joins, full-text search, and sync-eligibility filtering are not implemented.

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

// Filter by type and/or date range, paginate with cursor.
const searchResult = await unifiedIndex.search({
  types: ["jpg", "png"],
  dateRange: { start: someHlc, end: laterHlc },
  limit: 50,
});

for (const item of searchResult.items) {
  console.log(item.dataRecord.id);
}

// Fetch a single record by id.
const singleItem = await unifiedIndex.getWithMetadata(recordId);
```

## API

### Factory

| Function | Description |
|---|---|
| `createUnifiedIndex(options)` | Creates a `UnifiedIndex` over a `DatabaseAdapter`. |
| `planQuery(query, databaseAdapter)` | Translates an `IndexQuery` into a planned `Query` for the adapter. |

### `UnifiedIndex`

| Method | Description |
|---|---|
| `search(query)` | Query data records with type filter, date range, and pagination. |
| `getWithMetadata(recordId)` | Retrieve a single data record by id. Returns `{ dataRecord }` — no metadata is joined in today's implementation. |

### Key Types

| Type | Description |
|---|---|
| `IndexQuery` | `{ types?, dateRange?, limit?, cursor? }`. |
| `IndexItem` | `{ dataRecord }`. |
| `IndexResult` | Paginated search result with `items`, `nextCursor`, and `hasMore`. |

## Testing

```bash
pnpm --filter @starkeep/query-orchestrator test
```
