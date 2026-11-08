---
"@starkeep/shared-space-api": minor
"@starkeep/storage-sqlite": patch
"@starkeep/storage-aurora-dsql": patch
---

Both app-syncable appliers refuse a file-index row whose `created_at` is not a serialized HLC, through the new `requireWellFormedFileIndexRow`. The check covers a row a node registers itself and a row a peer pushes over sync. The sync engine treats the refusal as it treats any failed apply: the log names the row, the author's watermark holds, and the response lists the author in `haltedAuthors`.
