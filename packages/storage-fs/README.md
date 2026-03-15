# @starkeep/storage-fs

Filesystem implementation of `ObjectStorageAdapter`. Stores binary objects on the local filesystem with content-addressable directory sharding.

## Installation

```bash
pnpm add @starkeep/storage-fs
```

## Usage

```typescript
import { FsObjectStorageAdapter } from "@starkeep/storage-fs";

const objectStorage = new FsObjectStorageAdapter({ basePath: "./data/objects" });
await objectStorage.init();

// Store an object with optional metadata
const fileBuffer = Buffer.from("hello world");
await objectStorage.put("document-001", fileBuffer, {
  contentType: "text/plain",
  metadata: { originalName: "notes.txt" },
});

// Retrieve an object
const result = await objectStorage.get("document-001");
if (result) {
  console.log(result.data);        // Buffer
  console.log(result.contentType);  // "text/plain"
  console.log(result.size);         // 11
}

// List objects by prefix
const listing = await objectStorage.list("document", { limit: 50 });
console.log(listing.keys);

// Delete an object
await objectStorage.delete("document-001");

await objectStorage.close();
```

## API

| Export | Description |
|---|---|
| `FsObjectStorageAdapter` | Class implementing `ObjectStorageAdapter` for the local filesystem |
| `FsObjectStorageAdapterOptions` | Options type: `{ basePath: string }` |

Objects are stored under a two-character prefix directory (derived from the key) to avoid large flat directories. Metadata is persisted in a companion `.meta.json` file alongside each object.

## Testing

```bash
pnpm --filter @starkeep/storage-fs test
```
