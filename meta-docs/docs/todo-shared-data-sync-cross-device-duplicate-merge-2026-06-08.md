# Cross-device duplicate-file merge on Drive shared-record sync

When two devices independently ingest the same shared item (same `owner_id`, same `original_filename`, same `content_hash`) before they have synced, each device mints its own `shared_records.id` locally. Both rows are individually valid.

When the Drive sync channel later tries to converge them, the receiving side fails:

- The receive-path upsert (`storage-sqlite/src/adapter.ts:95` and the DSQL equivalent) is keyed on `id` with `ON CONFLICT(id) DO UPDATE`. The ids differ, so it falls through to an INSERT.
- The natural-key unique index — `uq_shared_records_owner_filename_hash` on `(owner_id, original_filename, content_hash) WHERE deleted_at IS NULL AND original_filename IS NOT NULL` — then rejects the INSERT with a unique-violation. The same index exists on both sides: `packages/storage-sqlite/src/schema/bootstrap.ts:57` and `packages/admin-installer/src/dsql-schema-init.ts:145`.

Result: the exchange round throws on that record. Depending on how the failure is handled, either the channel wedges on it or the watermark advances past it and the two devices stay permanently divergent (one has row A, the other has row B, neither learns about the other). Any child records whose `parent_id` points at the loser get orphaned once a merge does happen.

This is reachable in the live design: a user who imports the same file on two devices before they sync, or restores from a backup on a second device, trips it.

## What the fix needs

- **Deterministic merge rule** so both sides pick the same survivor without coordination. Candidates: lowest `id` wins, or earliest `created_at` wins. Pick one and apply uniformly on both adapters.
- **Either** upsert-on-natural-key in the receive-path adapter (so the INSERT becomes an UPDATE on `(owner_id, original_filename, content_hash)` when the id-keyed lookup misses), **or** a pre-insert lookup-and-rewrite in the Drive channel's exchange handler that maps the incoming id to the local survivor's id before handing it to the adapter.
- **Rewrite `parent_id` references on the loser** to point at the winner before deleting the loser, so child records (e.g. thumbnails) follow the surviving row.
- **Both adapters.** The local sqlite receive path and the DSQL receive path both carry the index and both need the fix.
- **Drive channel scope.** Shared-record sync flows exclusively through the Drive (User-Data-Owner) channel; the fix belongs on each side's Drive exchange handler / receive adapter, not on the per-app sync engine.

## Notes for revisit

- Touches the same family of "what does sync settlement allow" reasoning as the blob-GC / `parent_id` integrity todo ([[todo-cloud-data-server-blob-gc]]) — coordinate when picking up either.
- Originally captured in `TODO.md` predating the Drive single-channel design; the deferral rationale ("revisit once multi-device sync is being exercised") has lapsed because multi-device shared sync via Drive *is* the live design.
