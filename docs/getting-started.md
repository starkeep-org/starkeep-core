# Getting Started

## Prerequisites

- Node.js 22 or later (required for built-in `node:sqlite`)
- pnpm 10.20 or later

## Installation

Clone the repository and install dependencies:

```bash
git clone <repo-url>
cd data-protocol
pnpm install
pnpm build
```

## Your first app

### 1. Initialize the SDK

The SDK needs a database adapter and an object storage adapter. For local development,
use SQLite and the local filesystem — no cloud account required.

```typescript
import { createStarkeepSdk } from "@starkeep/sdk"
import { SqliteDatabaseAdapter } from "@starkeep/storage-sqlite"
import { FsObjectStorageAdapter } from "@starkeep/storage-fs"
import {
  IMAGE_DIMENSIONS_GENERATOR,
  FILE_PROPERTIES_GENERATOR,
  TEXT_PREVIEW_GENERATOR,
} from "@starkeep/metadata-core"

const sdk = await createStarkeepSdk({
  databaseAdapter: new SqliteDatabaseAdapter({ path: "./my-app.db" }),
  objectStorageAdapter: new FsObjectStorageAdapter({ basePath: "./storage" }),
  ownerId: "user-123",
  nodeId: "my-device",
  generators: [
    IMAGE_DIMENSIONS_GENERATOR,
    FILE_PROPERTIES_GENERATOR,
    TEXT_PREVIEW_GENERATOR,
  ],
})
```

### 2. Store a record

Records that are purely structured data (no attached file):

```typescript
const task = await sdk.data.put({
  type: "tasks:task",
  ownerId: "user-123",
  payload: {
    title: "Write documentation",
    status: "todo",
  },
})

console.log(task.id)         // ULID like "01HXYZ..."
console.log(task.createdAt)  // HLC timestamp
```

Records with an attached file:

```typescript
import { readFile } from "node:fs/promises"

const photoBytes = await readFile("./photo.jpg")

const photo = await sdk.data.putWithFile(
  {
    type: "photos:photo",
    ownerId: "user-123",
    payload: { album: "vacation", caption: "Beach sunset" },
  },
  photoBytes,
  "image/jpeg",
)

console.log(photo.contentHash)       // SHA-256 of file content
console.log(photo.objectStorageKey)  // path in object storage
console.log(photo.sizeBytes)         // file size
```

### 3. Retrieve records

```typescript
// By ID
const record = await sdk.data.get(photo.id)

// Search — returns data records joined with their metadata
const results = await sdk.index.search({
  types: ["photos:photo"],
  limit: 20,
})

for (const item of results.items) {
  console.log(item.dataRecord.payload.caption)
  console.log(item.metadata)  // keyed by generatorId
}

// Next page
const page2 = await sdk.index.search({
  types: ["photos:photo"],
  limit: 20,
  cursor: results.nextCursor,
})
```

### 4. Generate metadata

If you registered generators, call `generateAll` after storing a record:

```typescript
const results = await sdk.metadata.generateAll(photo.id, "photos:photo")

for (const result of results) {
  console.log(result.metadataRecord.generatorId)
  // "image-dimensions" → { width: 4032, height: 3024, format: "jpeg" }
  // "file-properties"  → { extension: ".jpg", mimeType: "image/jpeg", sizeBytes: 2048 }
  console.log(result.metadataRecord.value)
}
```

### 5. Search with metadata filters

```typescript
const largePhotos = await sdk.index.search({
  types: ["photos:photo"],
  metadataFilters: [
    {
      generatorId: "image-dimensions",
      field: "width",
      operator: "gte",
      value: 3000,
    },
  ],
  limit: 50,
})
```

### 6. Aggregations

```typescript
const stats = await sdk.aggregations.compute({
  types: ["photos:photo"],
  dateGranularity: "month",
})

console.log(`${stats.totalCount} photos, ${stats.totalSizeBytes} bytes`)
console.log(stats.countsByMimeType)
// { "image/jpeg": 42, "image/png": 7 }
console.log(stats.dateHistogram)
// [{ period: "2025-01", count: 12, sizeBytes: 3_000_000 }, ...]
```

### 7. Cleanup

```typescript
await sdk.close()
```

## Adding sync

To sync local data to the cloud, pass remote adapters when initializing:

```typescript
import { S3ObjectStorageAdapter } from "@starkeep/storage-s3"

const sdk = await createStarkeepSdk({
  // local (required)
  databaseAdapter: new SqliteDatabaseAdapter({ path: "./local.db" }),
  objectStorageAdapter: new FsObjectStorageAdapter({ basePath: "./local-files" }),
  ownerId: "user-123",
  nodeId: "my-laptop",

  // remote (enables sdk.sync)
  remoteDatabaseAdapter: auroraDsqlAdapter,
  remoteObjectStorageAdapter: new S3ObjectStorageAdapter({
    bucketName: "starkeep-user-123-data",
    region: "us-east-1",
  }),
})

// Bidirectional sync
const result = await sdk.sync.fullSync()
console.log(`pulled: ${result.pulled}, pushed: ${result.pushed}, conflicts: ${result.conflicts}`)

// Subscribe to sync events
const unsubscribe = sdk.sync.onUpdate((event) => {
  if (event.eventType === "remote-update-available") {
    console.log("New data from cloud:", event.recordIds)
  }
})
```

## Access control

```typescript
// Grant read access to another user
const policy = await sdk.accessControl.createPolicy({
  subjectType: "user",
  subjectId: "user-456",
  resourceType: "collection",
  resourceId: "vacation-album",
  permissions: ["read"],
})

// Check access
const check = await sdk.accessControl.checkAccess({
  subjectType: "user",
  subjectId: "user-456",
  resourceId: photo.id,
  permission: "read",
})
console.log(check.allowed)  // true or false
console.log(check.reason)   // explanation

// Create a shareable token
const { token } = await sdk.accessControl.createSharingToken(policy.policyId, {
  maxUses: 10,
})
// Share `token` externally — recipient validates it to get access
```

## Writing a custom metadata generator

```typescript
import type { GeneratingFunctionDefinition } from "@starkeep/metadata-engine"

const wordCountGenerator: GeneratingFunctionDefinition = {
  generatorId: "my-app:word-count",
  generatorVersion: 1,
  inputTypes: ["docs:document"],
  dependsOn: [],

  async generate(input, context) {
    const record = await context.databaseAdapter.get(input.dataRecordId)
    const text = record?.payload?.content as string ?? ""
    const words = text.trim().split(/\s+/).filter(Boolean).length
    return { value: { wordCount: words } }
  },
}

const sdk = await createStarkeepSdk({
  // ...
  generators: [wordCountGenerator],
})
```

## Registering Shared Space API endpoints

```typescript
import { createSharedSpaceApi } from "@starkeep/shared-space-api"

const api = createSharedSpaceApi({
  databaseAdapter,
  objectStorageAdapter,
  clock,
  ownerId: "user-123",
})

api.router.register({
  namespace: "photos",
  version: "v1",
  path: "/albums",
  method: "GET",
  description: "List all photo albums",
  handler: async (request, context) => {
    const results = await context.databaseAdapter.query({
      type: "photos:album",
      sort: [{ field: "createdAt", direction: "desc" }],
      limit: 50,
    })
    return { status: 200, body: results }
  },
})

// Handle an incoming request
const response = await api.handleRequest({
  path: "/photos/v1/albums",
  method: "GET",
  subject: { subjectType: "user", subjectId: "user-123" },
})
```

## Next steps

- [Building an App](building-an-app.md) — a full walkthrough using the Tasks app
- [Core Concepts](concepts.md) — deeper explanation of records, sync, and access control
- [Architecture](architecture.md) — how the packages fit together
