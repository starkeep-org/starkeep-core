# @starkeep/storage-s3

AWS S3 implementation of `ObjectStorageAdapter` for cloud file storage.

**Use this when:** deploying a user's cloud stack. In the full architecture, each user
gets their own S3 bucket.

## Usage

```typescript
import { S3ObjectStorageAdapter } from "@starkeep/storage-s3"

const adapter = new S3ObjectStorageAdapter({
  bucketName: "starkeep-user-alice-data",
  region: "us-east-1",
  keyPrefix: "files/",      // optional prefix for all keys
  credentials: {             // optional; defaults to env vars / IAM role
    accessKeyId: "...",
    secretAccessKey: "...",
  },
})

await adapter.init()
```

## Features

- **Multipart upload** for files larger than 5 MB
- **Pre-signed URLs** via `getSignedUrl(key, options)` — generate time-limited URLs
  for direct client downloads without proxying through your server
- Lazy S3 client initialization — the client isn't created until the first operation

## Notes

- Credentials default to the standard AWS credential chain (environment variables,
  `~/.aws/credentials`, IAM instance/task role)
- `keyPrefix` is useful when multiple apps share a bucket; all keys are prefixed
  transparently
