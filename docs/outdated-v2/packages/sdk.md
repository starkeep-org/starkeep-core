# @starkeep/sdk

The recommended entry point for all application code. `createStarkeepSdk()` wires
together storage, metadata, search, sync, access control, and the API framework,
returning a single object with namespaced operations.

## Initializing

```typescript
import { createStarkeepSdk } from "@starkeep/sdk"
import { SqliteDatabaseAdapter } from "@starkeep/storage-sqlite"
import { FsObjectStorageAdapter } from "@starkeep/storage-fs"

const sdk = await createStarkeepSdk({
  databaseAdapter: new SqliteDatabaseAdapter({ path: "./app.db" }),
  objectStorageAdapter: new FsObjectStorageAdapter({ basePath: "./files" }),
  ownerId: "user-123",
  nodeId: "laptop",                  // unique per device; used for HLC tie-breaking
  generators: [/* metadata generators */],
})
```

To enable sync, also pass remote adapters:

```typescript
const sdk = await createStarkeepSdk({
  // local adapters (required)
  databaseAdapter: ...,
  objectStorageAdapter: ...,
  ownerId: "user-123",
  nodeId: "laptop",

  // remote adapters (optional — enables sdk.sync)
  remoteDatabaseAdapter: ...,
  remoteObjectStorageAdapter: ...,
})
```

## sdk.data — Data operations

```typescript
// Create or update a record
const record = await sdk.data.put({
  type: "tasks:task",
  ownerId: "user-123",
  payload: { title: "Write docs", status: "todo" },
})

// Create a record with an attached file
const photo = await sdk.data.putWithFile(
  { type: "photos:photo", ownerId: "user-123", payload: { album: "2025" } },
  fileBuffer,
  "image/jpeg",   // content type (optional; inferred if omitted)
)

const record = await sdk.data.get(id)
await sdk.data.delete(id)
```

## sdk.metadata — Metadata generation

```typescript
// Generate all applicable metadata for a record
const results = await sdk.metadata.generateAll(photo.id, "photos:photo")

// Generate a specific metadata type
const result = await sdk.metadata.generate("image-dimensions", photo.id)

// Fetch all stored metadata for a record
const all = await sdk.metadata.getForRecord(photo.id)

// Check if stored metadata is stale
const stale = await sdk.metadata.checkStaleness(metadataRecordId)
```

## sdk.index — Search

```typescript
const results = await sdk.index.search({
  types: ["tasks:task"],
  metadataFilters: [
    { generatorId: "tasks:meta", field: "assignee", operator: "eq", value: "alice" },
  ],
  limit: 50,
})

const item = await sdk.index.getWithMetadata(recordId)

// Sync boundary
await sdk.index.syncBoundary.markSyncEligible(id)
await sdk.index.syncBoundary.markLocalOnly(id)
```

## sdk.aggregations — Summaries

```typescript
const stats = await sdk.aggregations.compute({ types: ["photos:photo"], dateGranularity: "month" })
await sdk.aggregations.incrementalUpdate([changedId])
sdk.aggregations.invalidate()
```

## sdk.sync — Sync (optional)

`sdk.sync` is `null` if no remote adapters were provided.

```typescript
if (sdk.sync) {
  const result = await sdk.sync.fullSync()
  const unsub = sdk.sync.onUpdate((event) => { /* ... */ })
}
```

## sdk.accessControl — Policies and tokens

```typescript
const policy = await sdk.accessControl.createPolicy({ ... })
await sdk.accessControl.revokePolicy(id)
const check = await sdk.accessControl.checkAccess({ ... })
const { token } = await sdk.accessControl.createSharingToken(policyId)
```

## sdk.api — HTTP API

```typescript
sdk.api.router.register({ namespace, version, path, method, handler })
const response = await sdk.api.handleRequest(request)
```

## Cleanup

```typescript
await sdk.close()  // closes all adapters and frees resources
```
