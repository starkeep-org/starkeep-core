# @starkeep/storage-fs

Local filesystem implementation of `ObjectStorageAdapter`. Stores files in a sharded
directory layout under a configured base path.

**Use this when:** building a local-first or desktop app, or pairing with the SQLite adapter
for fully offline operation.

## Usage

```typescript
import { FsObjectStorageAdapter } from "@starkeep/storage-fs"

const adapter = new FsObjectStorageAdapter({ basePath: "./storage" })
await adapter.init()  // creates the base directory if it doesn't exist
```

## Storage layout

Files are stored at `<basePath>/<first-2-chars-of-key>/<key>` to avoid large flat
directories. Each file has a `.meta.json` sidecar that stores content type and any
other metadata passed at write time.

## Notes

- No pre-signed URL support (that's an S3-only feature)
- Suitable for development and desktop deployments; for production cloud use, prefer S3
