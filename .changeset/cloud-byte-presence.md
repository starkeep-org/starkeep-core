---
"@starkeep/protocol-primitives": minor
"@starkeep/storage-adapter": minor
"@starkeep/shared-space-api": minor
"@starkeep/storage-aurora-dsql": patch
"@starkeep/sync-engine": minor
---

The cloud signs no URL for a shared file that has not reached S3. `RecordAvailability` gains `awaiting-upload`, stand-in sizes and variant candidates carry `awaiting_upload: true` in place of a URL, and the single-record reads answer `409 AwaitingUpload`. `VariantCandidate` carries the child's `updatedAt`, which the cloud compares with Drive's bytes watermark. `verify()` reports `filesOwed` and `filesOwedCapped`: the files the peer is still owed, since rows now reach it ahead of their files.
