---
"@starkeep/sync-engine": minor
"@starkeep/shared-space-api": minor
"@starkeep/storage-adapter": minor
"@starkeep/storage-sqlite": minor
"@starkeep/storage-aurora-dsql": minor
---

Row writes report what they did. `AppSyncableApplier.apply` takes optional write conditions and returns the changed-row count, plus a skip reason (`live`, `deleted`, `missing` or `stale`) for an app's own write that changed nothing. `insertRow` accepts `ifAbsent`, which counts a deleted row as present. `updateRow` and `deleteRow` accept `ifUpdatedAt` for compare-and-set. All three return a `RowWriteResult` in place of a bare number. An update or a key-only delete now matches live rows only, so a patch no longer lands on a tombstone and a repeated delete no longer re-stamps one. `rowWriteResponse` maps a result to the HTTP status both data servers answer with, and `appSyncableWriteConformance` holds the cases each SQL applier runs.
