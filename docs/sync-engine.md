# sync-engine

One version-vector exchange round per `exchange()`. Each side tracks watermarks per `nodeId`: `ownWatermarks` = highest HLC applied from each peer; `peerWatermarks` = highest HLC shipped to the peer.

## Per-record residency

Each record has one of four states per side (`absent`, `staged`, `resident`, `tombstoned`) — derived from row + blob + `deletedAt` via `residencyOf` in `residency.ts`. The watermark is the durable backstop for Staged: a record whose metadata landed but whose blob hasn't must not have its watermark advanced, or the blob will never be retried.

## Per-nodeId contiguous-prefix shipping

Records (SR) and reserved-table app rows (AR) are interleaved per `nodeId` in HLC order. A blob failure halts shipping for the rest of that nodeId in the round; the watermark advances only over the contiguous successful prefix. Other nodeIds are unaffected. Without this rule the watermark could leapfrog a failed record and orphan it.

## LWW conflict resolution

`compareHLC` orders by (wallTime, counter, nodeId); the larger nodeId wins ties. AR/AW get the same ordering via lexicographic compare of the serialized `updated_at`. Cross-side bytewise-identical timestamps cannot occur — `nodeId` is part of the string.

## Loser-blob fate

Loser-blob fate: with content-addressable storage, a real content change produces a new `object_storage_key`, so "loser blob discarded" is implicit (loser bytes live at the loser's key, the record points at the winner's).

## Pagination

`pageLimit` caps the per-round ship count (combined SR + AR/AW, ordered by HLC) and the inbound request limit. The outbound and responder scans are cursor-paginated, applying the per-nodeId watermark filter inline as the cursor advances — records past any scan window stay reachable on later pages. Production adapters should push the filter into the query (per-nodeId index + `WHERE updated_at > watermark`) so steady-state syncs don't read every row.
