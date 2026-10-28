---
"@starkeep/sync-engine": patch
---

The in-process transport takes `fileRecords`, the adapter that holds the library's file rows when it differs from the channel's own. The bytes walk then starts from the whole library's rows watermark and clamps to the channel's, as the cloud does for a type-scoped mobile exchange.
