# @starkeep/aggregations

Computes counts, sizes, and date histograms over data records with caching and incremental updates.

## Installation

```bash
pnpm add @starkeep/aggregations
```

## Usage

```ts
import { createAggregationEngine } from "@starkeep/aggregations";

const aggregationEngine = createAggregationEngine({
  databaseAdapter: myDatabaseAdapter,
});

// Compute full aggregations
const result = await aggregationEngine.compute({
  types: ["photo", "video"],
  dateGranularity: "month",
});

console.log(result.totalCount);
console.log(result.totalSizeBytes);
console.log(result.countsByType);       // { photo: 120, video: 30 }
console.log(result.countsByMimeType);   // { "image/jpeg": 100, ... }
console.log(result.dateHistogram);      // [{ period: "2026-01", count: 15, sizeBytes: ... }]

// Use cached result if available
const cached = aggregationEngine.getCached();

// Incrementally update after changes
const updated = await aggregationEngine.incrementalUpdate([changedRecordId]);

// Invalidate cache to force full recomputation
aggregationEngine.invalidate();
```

## API

### Factory Functions

| Function | Description |
|---|---|
| `createAggregationEngine(options)` | Creates an `AggregationEngine` backed by a database adapter |
| `buildDateHistogram(entries, granularity)` | Builds a date histogram from raw entries |
| `computeDateBucket(timestamp, granularity)` | Returns the bucket key for a timestamp at the given granularity |

### `AggregationEngine`

| Method | Description |
|---|---|
| `compute(options?)` | Compute aggregations, optionally filtered by types and date granularity |
| `incrementalUpdate(changedRecordIds)` | Recompute aggregations incorporating only the changed records |
| `getCached()` | Return the cached aggregation result, or `null` if invalidated |
| `invalidate()` | Clear the cached result |

### Key Types

| Type | Description |
|---|---|
| `AggregationResult` | Total count, total size, counts by type, counts by MIME type, and date histogram |
| `AggregationOptions` | Optional type filter and date granularity (`"day"`, `"week"`, `"month"`, `"year"`) |
| `DateHistogramBucket` | A single histogram bucket with period string, count, and size in bytes |
| `DateGranularity` | `"day"` \| `"week"` \| `"month"` \| `"year"` |

## Testing

```bash
pnpm --filter @starkeep/aggregations test
```
