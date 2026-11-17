---
"@starkeep/storage-sqlite": minor
"@starkeep/sync-engine": minor
---

The local schema gains `retained_app_data`, which records an app's syncable tables and files once an uninstall keeps them. `deleteSqliteUploadQueueChannel` deletes one channel's upload-queue rows, for deleting an app's data on a node.
