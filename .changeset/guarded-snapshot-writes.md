---
"@starkeep/storage-adapter": minor
"@starkeep/storage-sqlite": minor
"@starkeep/storage-aurora-dsql": minor
"@starkeep/sync-engine": minor
---

The sync apply path decides last-writer-wins inside its writes. `DatabaseAdapter.putSnapshot` is an upsert that replaces a row only with a strictly later `updatedAt`, and `putLabel` has the same guard; both resolve `true` when they wrote and `false` when a newer row was kept. Before this, the apply paths compared HLCs with a `get` and then wrote with an unconditional upsert in a separate transaction, so a concurrent round could land a newer row in between and the older write replaced it, after the newer one had raised its author's coverage. The responder and the requester now write through these methods and re-read the row when a write is kept out. On DSQL the coverage raise is issued either way and records nothing after a skipped write. `put` keeps its unconditional behaviour for the local write paths. An adapter implementing `DatabaseAdapter` outside this repository needs a `putSnapshot`, and its `putLabel` must return a boolean.
