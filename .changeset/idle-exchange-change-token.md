---
"@starkeep/sync-engine": minor
"@starkeep/storage-aurora-dsql": minor
---

An idle sync exchange is answered from a change token instead of the responder's watermarks. The responder reads its channel's token after applying the request and before reading any data, returns it as `changeToken` when its reply leaves the requester nothing to come back for, and answers `unchanged: true` when a later request echoes a token that still matches. The requester echoes its stored token only on a round with nothing to push and no repair outstanding, keeps its peer watermarks on an unchanged reply, and stores a new token only beside the peer watermarks it came with. `SyncStateStore` gains optional `getChangeToken` and `setChangeToken`; a store without them never sends a token.

On DSQL, every adapter and applier write runs in one transaction that replaces its channel's row in `shared.change_heads` with a database-generated token. `guardChangeHeads` wraps a client so that a write to a synced table outside a transaction, a commit that skipped its channel's head, and any other write to the heads are refused. Label upserts split at 2,999 rows so the head fits under DSQL's 3,000-row transaction cap, and each label retraction runs in its own transaction.
