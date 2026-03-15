# @starkeep/sdk

High-level facade over all Starkeep packages. Provides a single entry point for data operations, metadata generation, search, aggregations, sync, access control, and API handling.

## Installation

```bash
pnpm add @starkeep/sdk
```

## Usage

```ts
import { createStarkeepSdk } from "@starkeep/sdk";

const starkeepSdk = createStarkeepSdk({
  databaseAdapter: localDatabaseAdapter,
  objectStorageAdapter: localObjectStorage,
  ownerId: "user-123",
  nodeId: "device-abc",
  // Optional: enable sync by providing remote adapters
  remoteDatabaseAdapter: remoteDatabaseAdapter,
  remoteObjectStorageAdapter: remoteObjectStorage,
  // Optional: register metadata generators
  generators: [imageDimensionsGenerator, textPreviewGenerator],
});

// Data operations
const record = await starkeepSdk.data.put({
  type: "photo",
  ownerId: "user-123",
  payload: { title: "Sunset", tags: ["nature"] },
});

const recordWithFile = await starkeepSdk.data.putWithFile(
  { type: "photo", ownerId: "user-123", payload: { title: "Beach" } },
  fileBuffer,
  "image/jpeg",
);

const fetched = await starkeepSdk.data.get(record.id);
await starkeepSdk.data.delete(record.id);

// Metadata
const generationResults = await starkeepSdk.metadata.generateAll(record.id, "photo");
const metadataRecords = await starkeepSdk.metadata.getForRecord(record.id);

// Search
const searchResult = await starkeepSdk.index.search({
  types: ["photo"],
  fullTextSearch: "sunset",
  limit: 20,
});

// Aggregations
const aggregationResult = await starkeepSdk.aggregations.compute({
  dateGranularity: "month",
});

// Sync (available when remote adapters are provided)
if (starkeepSdk.sync) {
  const syncResult = await starkeepSdk.sync.fullSync();
  const unsubscribe = starkeepSdk.sync.onUpdate((changeEvent) => {
    console.log(changeEvent.eventType, changeEvent.recordIds);
  });
}

// Access control
const policy = await starkeepSdk.accessControl.createPolicy({
  subjectType: "user",
  subjectId: "user-456",
  resourceType: "type",
  resourceId: "photo",
  permissions: ["read"],
});

// API
const apiResponse = await starkeepSdk.api.handleRequest({
  path: "/photos/v1/albums",
  method: "GET",
  subject: { subjectType: "user", subjectId: "user-456" },
});

// Cleanup
await starkeepSdk.close();
```

## API

### Factory Function

| Function | Description |
|---|---|
| `createStarkeepSdk(options)` | Creates a `StarkeepSdk` instance wiring together all subsystems |

### `StarkeepSdk`

| Member | Description |
|---|---|
| `data` | `DataOperations` -- put, get, delete records and files |
| `metadata` | `MetadataOperations` -- generate and retrieve metadata for records |
| `index` | `IndexOperations` -- search across data and metadata |
| `aggregations` | `AggregationOperations` -- compute counts, sizes, and histograms |
| `sync` | `SyncOperations \| null` -- push, pull, full sync, and change subscriptions (null when no remote adapters) |
| `accessControl` | `AccessControlOperations` -- create/revoke policies and check access |
| `api` | `ApiOperations` -- handle shared space API requests |
| `close()` | Clean up resources |

### `StarkeepSdkOptions`

| Option | Required | Description |
|---|---|---|
| `databaseAdapter` | Yes | Local database adapter |
| `objectStorageAdapter` | Yes | Local object storage adapter |
| `ownerId` | Yes | Owner identifier for records |
| `nodeId` | Yes | Unique node ID for HLC clock |
| `clock` | No | Custom HLC clock instance |
| `remoteDatabaseAdapter` | No | Remote database adapter (enables sync) |
| `remoteObjectStorageAdapter` | No | Remote object storage adapter (enables sync) |
| `generators` | No | Metadata generator definitions to register |

### Re-exported Types

The SDK re-exports commonly used types from `@starkeep/core` for convenience: `StarkeepId`, `DataRecord`, `MetadataRecord`, `HLCTimestamp`, `CreateDataRecordInput`, `CreateMetadataRecordInput`.

## Testing

```bash
pnpm --filter @starkeep/sdk test
```
