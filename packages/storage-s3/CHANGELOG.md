# @starkeep/storage-s3

## 0.5.1

### Patch Changes

- Updated dependencies [fcd80e9]
  - @starkeep/storage-adapter@0.7.0

## 0.5.0

### Minor Changes

- e362220: Resumable multipart upload for large files. A node that supplies `hashFileParts` and `uploadFileRange` to `HttpObjectStorageAdapter` sends files above 64 MiB as fixed 16 MiB parts, each pinned to its SHA-256, and resumes an interrupted upload from the parts it already sent. The whole-file SHA-256 stays the content hash and the key. "Free up space" proves a multipart object by rehashing the local copy into the same composite checksum S3 stores.

### Patch Changes

- Updated dependencies [e362220]
  - @starkeep/storage-adapter@0.6.0

## 0.4.0

### Minor Changes

- Publish the engine changes made since the 0.4 package set (2026-08-02) and the 0.3 set (2026-07-29), which went unpublished: sync in bounded rounds with a delta scan, and the residency fixes; content-addressed shared records keyed on parent, filename and hash; metadata that syncs with its record; the shared query grammar; stand-ins and the reduced storage settings; record deletion, the deleted feed and blob reclamation; rows that travel ahead of their files; and per-user object keys, user-scoped cloud statements and device sign-in. Most of these change the wire format or the stored layout, so every node must run this set together.

### Patch Changes

- Updated dependencies
  - @starkeep/storage-adapter@0.5.0
