# @starkeep/sync-engine

## 0.9.2

### Patch Changes

- 317a926: The DSQL adapter and applier read sync coverage from per-author watermark tables instead of grouping every row the user owns. `shared.node_watermarks_records`, `shared.node_watermarks_labels` and each app schema's `_starkeep_node_watermarks` hold, per user, author and type or table, the highest `updated_at` that has landed. Every write to a synced table now runs in a transaction that raises its authors' entries from the rows it wrote. An entry never decreases, so an author whose rows were all superseded keeps its coverage. Each adapter and applier instance reads each table once until its next write.

  `guardNodeWatermarks` wraps a client and refuses a synced write outside a transaction, a commit that skipped its raise, any other write to the watermark tables, and savepoints. A type-scoped adapter narrows the watermark tables by type, as it narrows records and labels. The owner scope now accepts an `insert … select` into an owned table and selects the user in the owner column. An installed app whose watermark table is missing throws from `getNodeWatermarks`, so the exchange reports incomplete coverage rather than none. The DSQL bytes-watermark store's `save` now replaces the stored map, as the memory store does, by deleting the rows of authors the map omits.

  `shared-space-api` exports `NODE_WATERMARKS_TABLE` and reserves the name. `storage-adapter` replaces `buildLabelNodeWatermarks` with `buildNodeWatermarks`, which serves the grouped reads SQLite still uses. The type scope narrows labels by their denormalized `record_type` instead of a semi-join to records.

- Updated dependencies [317a926]
  - @starkeep/storage-adapter@0.8.0

## 0.9.1

### Patch Changes

- 18b7a5f: The in-process transport takes `fileRecords`, the adapter that holds the library's file rows when it differs from the channel's own. The bytes walk then starts from the whole library's rows watermark and clamps to the channel's, as the cloud does for a type-scoped mobile exchange.
- Updated dependencies [18b7a5f]
  - @starkeep/protocol-primitives@0.7.0
  - @starkeep/storage-adapter@0.7.1

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
