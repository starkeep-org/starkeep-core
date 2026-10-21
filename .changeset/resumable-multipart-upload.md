---
"@starkeep/storage-adapter": minor
"@starkeep/storage-s3": minor
"@starkeep/sync-engine": minor
---

Resumable multipart upload for large files. A node that supplies `hashFileParts` and `uploadFileRange` to `HttpObjectStorageAdapter` sends files above 64 MiB as fixed 16 MiB parts, each pinned to its SHA-256, and resumes an interrupted upload from the parts it already sent. The whole-file SHA-256 stays the content hash and the key. "Free up space" proves a multipart object by rehashing the local copy into the same composite checksum S3 stores.
