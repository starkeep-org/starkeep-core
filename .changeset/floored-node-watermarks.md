---
"@starkeep/storage-adapter": minor
"@starkeep/storage-aurora-dsql": minor
"@starkeep/sync-engine": patch
---

Watermark reads take an optional floor, a peer's watermarks, and may then omit an author whose maximum sits below its floor. `readNodeWatermarks` reads relative to the floor with one statement of bounded seeks and falls back to the grouped read when the floor misses an author. The DSQL adapter and applier use it for their delta scans and coverage reports, and the in-process transport reads coverage with the requester's watermarks, re-reading whole only when this side is behind. An idle exchange on DSQL now reads a few rows instead of every row the user has in the channel.
