---
"@starkeep/sync-engine": patch
---

When a row from the peer fails to apply, the requester now advances that author's watermark, and its inbound repair floor, only to the last HLC strictly below the failed row. It used to take the row just before the failure, and when that row shared the failed row's HLC, the watermark claimed the failed row and it was never offered again. No current write path produced that shape, since only a record can fail and a record sorts first among rows sharing its HLC.
