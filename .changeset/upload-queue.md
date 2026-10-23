---
"@starkeep/sync-engine": minor
---

Uploads leave the sync round. `createSyncEngine` returns an `uploader` that drains a persistent queue beside the round: small stand-ins first, newest first, then originals oldest first, in size lanes with no barrier between files. One `POST /files/presign-batch` request answers presence and signs the PUTs for up to 32 files, in place of a HEAD and a presign per file. Reconciliation against the cloud's bytes watermark corrects the queue when the cloud loses files or a repair floor applies.

Breaking: `ExchangeResult.uploaded` and `uploadedBytes` are gone, a round no longer reports an upload failure as `blocked`, and `bytesHasMore` covers downloads only. A node passes `uploadQueue: createSqliteUploadQueueStore({ db, channel })` so its queue survives a restart, and starts or drains `engine.uploader`. `HttpObjectStorageAdapter` gains `presignUploads`, `uploadPresigned` and `sendsInParts`, and the in-process transport takes an `onWalk` hook.
