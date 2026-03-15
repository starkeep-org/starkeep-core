# Getting Started

## Installation

```bash
git clone <repo-url>
cd data-protocol
pnpm install
pnpm build
```

## Quick start: local SDK

The fastest way to use the data protocol is with the SDK and local adapters (SQLite + filesystem). No AWS account needed.

```typescript
import { createStarkeepSdk } from "@starkeep/sdk"
import { SqliteDatabaseAdapter } from "@starkeep/storage-sqlite"
import { FsObjectStorageAdapter } from "@starkeep/storage-fs"
import { registerCoreMetadataGenerators } from "@starkeep/metadata-core"
import { createGeneratorRegistry } from "@starkeep/metadata-engine"
import {
  IMAGE_DIMENSIONS_GENERATOR,
  FILE_PROPERTIES_GENERATOR,
  TEXT_PREVIEW_GENERATOR,
} from "@starkeep/metadata-core"

// Initialize adapters
const databaseAdapter = new SqliteDatabaseAdapter({ path: "./my-app.db" })
const objectStorageAdapter = new FsObjectStorageAdapter({ basePath: "./storage" })

// Create SDK
const sdk = await createStarkeepSdk({
  databaseAdapter,
  objectStorageAdapter,
  ownerId: "user-123",
  nodeId: "device-abc",
  generators: [
    IMAGE_DIMENSIONS_GENERATOR,
    FILE_PROPERTIES_GENERATOR,
    TEXT_PREVIEW_GENERATOR,
  ],
})
```

## Storing data

### Record-only data (no file)

```typescript
const message = await sdk.data.put({
  type: "ai:message",
  ownerId: "user-123",
  payload: {
    conversationId: "conv-1",
    role: "user",
    content: "Hello, world!",
  },
})

console.log(message.id)  // ULID like "01HXYZ..."
```

### File-backed data

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

console.log(photo.contentHash)       // SHA-256 hash
console.log(photo.objectStorageKey)  // storage path
console.log(photo.sizeBytes)         // file size
```

## Retrieving data

```typescript
// By ID
const record = await sdk.data.get(photo.id)

// Search with the index
const results = await sdk.index.search({
  types: ["photos:photo"],
  limit: 20,
})

for (const item of results.items) {
  console.log(item.dataRecord.payload.caption)
  console.log(item.metadata)  // all generated metadata
}
```

## Generating metadata

If you registered generators when creating the SDK, metadata is generated on demand:

```typescript
// Generate all applicable metadata for a record
const results = await sdk.metadata.generateAll(photo.id, "photos:photo")

for (const result of results) {
  console.log(result.metadataRecord.generatorId)  // e.g., "image-dimensions"
  console.log(result.metadataRecord.value)         // e.g., { width: 4032, height: 3024, format: "jpeg" }
}

// Generate a specific metadata type
const dimensions = await sdk.metadata.generate("image-dimensions", photo.id)
console.log(dimensions.metadataRecord.value.width)

// Fetch all metadata for a record
const allMetadata = await sdk.metadata.getForRecord(photo.id)
```

## Querying with metadata filters

Search across data and metadata simultaneously:

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

## Aggregations

```typescript
const stats = await sdk.aggregations.compute({
  types: ["photos:photo"],
  dateGranularity: "month",
})

console.log(`${stats.totalCount} photos, ${stats.totalSizeBytes} bytes total`)
console.log(stats.countsByMimeType)   // { "image/jpeg": 42, "image/png": 7 }
console.log(stats.dateHistogram)      // [{ period: "2025-01", count: 12, sizeBytes: ... }, ...]
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

## Sync (local to cloud)

Sync requires remote adapters. Here's an example using S3 + Aurora DSQL:

```typescript
import { createStarkeepSdk } from "@starkeep/sdk"
import { SqliteDatabaseAdapter } from "@starkeep/storage-sqlite"
import { FsObjectStorageAdapter } from "@starkeep/storage-fs"
import { S3ObjectStorageAdapter } from "@starkeep/storage-s3"
// Aurora DSQL adapter requires a DatabaseClientFactory (see api-reference.md)

const sdk = await createStarkeepSdk({
  databaseAdapter: new SqliteDatabaseAdapter({ path: "./local.db" }),
  objectStorageAdapter: new FsObjectStorageAdapter({ basePath: "./local-files" }),
  ownerId: "user-123",
  nodeId: "laptop",

  // Enable sync by providing remote adapters
  remoteDatabaseAdapter: remoteDatabaseAdapter,
  remoteObjectStorageAdapter: new S3ObjectStorageAdapter({
    bucketName: "starkeep-user-123-data",
    region: "us-east-1",
  }),
})

// sdk.sync is now available (non-null)

// Bidirectional sync
const result = await sdk.sync.fullSync()
console.log(`Pulled ${result.pulled}, pushed ${result.pushed}, ${result.conflicts} conflicts`)

// Subscribe to sync events
const unsubscribe = sdk.sync.onUpdate((event) => {
  if (event.eventType === "remote-update-available") {
    console.log("New data available from cloud!")
  }
})
```

## Writing a custom metadata generator

```typescript
import type { GeneratingFunctionDefinition } from "@starkeep/metadata-engine"

const sentimentGenerator: GeneratingFunctionDefinition = {
  generatorId: "my-app:sentiment",
  generatorVersion: 1,
  inputTypes: ["ai:message"],
  dependsOn: [],

  async generate(input, context) {
    const record = await context.databaseAdapter.get(input.dataRecordId)
    const text = record?.payload?.content as string ?? ""

    // Your analysis logic here
    const sentiment = text.includes("!") ? "positive" : "neutral"

    return {
      value: { sentiment, confidence: 0.85 },
    }
  },
}

// Register when creating the SDK
const sdk = await createStarkeepSdk({
  // ...
  generators: [sentimentGenerator],
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

## Cleanup

```typescript
await sdk.close()  // closes all adapters
```

## Running the example apps

```bash
# Photo management app
pnpm --filter @starkeep/example-photo-app dev

# AI assistant
pnpm --filter @starkeep/example-ai-assistant dev

# Admin panel (browser)
pnpm --filter @starkeep/example-admin-panel dev

# Admin panel (Tauri desktop)
pnpm --filter @starkeep/example-admin-panel tauri:dev
```
