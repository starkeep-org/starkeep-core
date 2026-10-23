# @starkeep/sync-engine

## 0.9.0

### Minor Changes

- 5247eda: Uploads leave the sync round. `createSyncEngine` returns an `uploader` that drains a persistent queue beside the round: small stand-ins first, newest first, then originals oldest first, in size lanes with no barrier between files. One `POST /files/presign-batch` request answers presence and signs the PUTs for up to 32 files, in place of a HEAD and a presign per file. Reconciliation against the cloud's bytes watermark corrects the queue when the cloud loses files or a repair floor applies.

  Breaking: `ExchangeResult.uploaded` and `uploadedBytes` are gone, a round no longer reports an upload failure as `blocked`, and `bytesHasMore` covers downloads only. A node passes `uploadQueue: createSqliteUploadQueueStore({ db, channel })` so its queue survives a restart, and starts or drains `engine.uploader`. `HttpObjectStorageAdapter` gains `presignUploads`, `uploadPresigned` and `sendsInParts`, and the in-process transport takes an `onWalk` hook.

### Patch Changes

- 80c9a42: `createSyncEngine` takes `filesOwedCap`, the number of owed files `verify()` counts before it reports `filesOwedCapped`. The default stays 10,000.

## 0.8.0

### Minor Changes

- fcd80e9: The cloud signs no URL for a shared file that has not reached S3. `RecordAvailability` gains `awaiting-upload`, stand-in sizes and variant candidates carry `awaiting_upload: true` in place of a URL, and the single-record reads answer `409 AwaitingUpload`. `VariantCandidate` carries the child's `updatedAt`, which the cloud compares with Drive's bytes watermark. `verify()` reports `filesOwed` and `filesOwedCapped`: the files the peer is still owed, since rows now reach it ahead of their files.

### Patch Changes

- Updated dependencies [fcd80e9]
  - @starkeep/protocol-primitives@0.6.0
  - @starkeep/storage-adapter@0.7.0

## 0.7.0

### Minor Changes

- e362220: Resumable multipart upload for large files. A node that supplies `hashFileParts` and `uploadFileRange` to `HttpObjectStorageAdapter` sends files above 64 MiB as fixed 16 MiB parts, each pinned to its SHA-256, and resumes an interrupted upload from the parts it already sent. The whole-file SHA-256 stays the content hash and the key. "Free up space" proves a multipart object by rehashing the local copy into the same composite checksum S3 stores.

### Patch Changes

- Updated dependencies [e362220]
  - @starkeep/storage-adapter@0.6.0

## 0.6.0

### Minor Changes

- Publish the engine changes made since the 0.4 package set (2026-08-02) and the 0.3 set (2026-07-29), which went unpublished: sync in bounded rounds with a delta scan, and the residency fixes; content-addressed shared records keyed on parent, filename and hash; metadata that syncs with its record; the shared query grammar; stand-ins and the reduced storage settings; record deletion, the deleted feed and blob reclamation; rows that travel ahead of their files; and per-user object keys, user-scoped cloud statements and device sign-in. Most of these change the wire format or the stored layout, so every node must run this set together.

### Patch Changes

- Updated dependencies
  - @starkeep/protocol-primitives@0.5.0
  - @starkeep/storage-adapter@0.5.0
