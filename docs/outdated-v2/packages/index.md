# @starkeep/index

Unified search and querying across data records and their metadata. The index joins data
records with their associated metadata so you can filter on both in a single query.

Access through the SDK as `sdk.index`.

## Search

```typescript
// All tasks assigned to Alice, ordered newest first
const results = await sdk.index.search({
  types: ["tasks:task"],
  metadataFilters: [
    {
      targetType: "tasks:task",
      generatorId: "tasks:properties",
      field: "assignee",
      operator: "eq",
      value: "alice",
    },
  ],
  limit: 50,
})

for (const item of results.items) {
  console.log(item.dataRecord.content)
  console.log(item.metadata)  // Record<generatorId, MetadataRecord>
}
console.log(results.nextCursor)  // pass to next query for pagination
```

## Query options

| Option | Description |
|--------|-------------|
| `types` | Filter to specific record types |
| `dateRange` | Filter by `createdAt` range |
| `metadataFilters` | Filter on metadata field values (targetType + generatorId + field + operator + value) |
| `syncBoundary` | `"sync-eligible"`, `"local-only"`, or `"all"` |
| `limit` | Maximum results per page |
| `cursor` | Pagination cursor from a previous result |

`metadataFilters` require `targetType` because metadata is stored in per-type tables.
Filter fields use `camelCase` (matching the generator's output value keys).

Metadata filter operators: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in`, `like`

## Fetching a single record with its metadata

```typescript
const item = await sdk.index.getWithMetadata(recordId)
// item.dataRecord  — the data record
// item.metadata    — all metadata entries keyed by generatorId
```

## Sync boundary

The sync boundary tracks which records are eligible to be pushed to the cloud. Records
are local-only by default; mark them sync-eligible when you want them to participate in sync.

```typescript
await sdk.index.syncBoundary.markSyncEligible(recordId)
await sdk.index.syncBoundary.markLocalOnly(recordId)
await sdk.index.syncBoundary.isSyncEligible(recordId)   // boolean
await sdk.index.syncBoundary.getSyncEligibleIds(since?)  // all eligible IDs
```
