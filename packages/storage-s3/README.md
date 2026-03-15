# @starkeep/storage-s3

Amazon S3 implementation of `ObjectStorageAdapter`. Supports multipart uploads for large objects and pre-signed URL generation.

## Installation

```bash
pnpm add @starkeep/storage-s3
```

## Usage

```typescript
import { S3ObjectStorageAdapter } from "@starkeep/storage-s3";

const objectStorage = new S3ObjectStorageAdapter({
  bucketName: "my-starkeep-bucket",
  region: "us-east-1",
  keyPrefix: "user-123/",         // optional prefix for all keys
  credentials: {                   // optional, falls back to default AWS credential chain
    accessKeyId: "AKIA...",
    secretAccessKey: "...",
  },
});

await objectStorage.init();

// Store an object (automatically uses multipart upload for files > 5 MB)
await objectStorage.put("photos/sunset.jpg", imageBuffer, {
  contentType: "image/jpeg",
  metadata: { uploadedBy: "user-123" },
});

// Retrieve an object
const result = await objectStorage.get("photos/sunset.jpg");

// Generate a pre-signed URL (default expiry: 1 hour)
const signedUrl = await objectStorage.getSignedUrl("photos/sunset.jpg", {
  expiresIn: 3600,
});

// List objects by prefix with pagination
const listing = await objectStorage.list("photos/", { limit: 100 });

await objectStorage.close();
```

## API

| Export | Description |
|---|---|
| `S3ObjectStorageAdapter` | Class implementing `ObjectStorageAdapter` for Amazon S3 |
| `S3ObjectStorageAdapterOptions` | Options: `bucketName`, `region`, optional `keyPrefix` and `credentials` |

The S3 client is created lazily on first use. Files larger than 5 MB are uploaded via the AWS SDK multipart `Upload` utility automatically.

## Testing

```bash
pnpm --filter @starkeep/storage-s3 test
```
