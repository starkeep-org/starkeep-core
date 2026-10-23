---
"@starkeep/sync-engine": patch
---

`createSyncEngine` takes `filesOwedCap`, the number of owed files `verify()` counts before it reports `filesOwedCapped`. The default stays 10,000.
