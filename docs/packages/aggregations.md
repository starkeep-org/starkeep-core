# @starkeep/aggregations

Computes summaries over collections of data records: total counts, total storage used,
breakdowns by type and MIME type, and histograms over time. Results are cached and can
be updated incrementally.

Access through the SDK as `sdk.aggregations`.

## Computing aggregations

```typescript
const stats = await sdk.aggregations.compute({
  types: ["photos:photo"],        // optional; omit to aggregate all types
  dateGranularity: "month",       // "day" | "week" | "month" | "year"
})

stats.totalCount                 // 1042
stats.totalSizeBytes             // 8_392_847_104
stats.countsByType               // { "photos:photo": 1042 }
stats.countsByMimeType           // { "image/jpeg": 987, "image/png": 55 }
stats.dateHistogram              // [{ period: "2025-01", count: 120, sizeBytes: ... }, ...]
```

## Incremental updates

When you know which records changed, recompute only the affected counts instead of
scanning the full collection:

```typescript
await sdk.aggregations.incrementalUpdate([changedRecordId1, changedRecordId2])
```

## Cache management

```typescript
sdk.aggregations.getCached()    // returns last computed result, or null
sdk.aggregations.invalidate()   // clears the cache; next compute() runs fresh
```
