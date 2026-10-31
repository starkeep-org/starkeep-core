---
"@starkeep/sync-engine": minor
---

The in-process transport's `declinesBlob(key)` option is now `declinesBlobs(keys)`, which returns the set of keys this side declines. The bytes walk still asks object storage about a batch's keys concurrently, then makes one awaited `declinesBlobs` call with the keys storage lacks, so an implementation can query the exchange's connection without overlapping another statement. A failed call counts every key in it as not held, as a failed per-key check did.
