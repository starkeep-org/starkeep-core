# Cloud-side janitor: blob GC and parent_id integrity for tombstoned shared records

Soft-deleting a shared record via `DELETE /data/records/{id}` stamps `deleted_at` on the DSQL row but leaves the S3 blob at `shared/<category>/<shard>/<hash>` in place. Nothing reclaims either. Under normal use, both the `shared.records` table and the files bucket grow monotonically; app-uninstall handles `apps/<appId>/*` private keys, but the shared prefix has no janitor.

The same tombstone-handling gap shows up in **`parent_id` integrity**: a child record (e.g. a thumbnail) whose parent is soft-deleted keeps pointing at the deleted parent row. Dedup-by-`(parentId, contentHash)` still works, but consumers reading `parent_id` get a stable reference to a deleted row. No code repoints or nulls `parent_id` anywhere today. This belongs to the same janitor workstream because the safety question is identical (when can we act on a tombstone, given sync settlement and dedup).

Non-trivial design choices to settle before implementing:

- **HLC settlement.** A blob must not be deleted until every channel that could resurrect or re-reference the underlying record (parent-id pointer, dedup-by-`(parentId, contentHash)`) has converged. The janitor needs a "safe to GC" cutoff that respects per-channel sync watermarks, not just `deleted_at`.
- **Dedup-aware deletion.** A single blob can be referenced by multiple live records (dedup-by-`(parentId, contentHash)` returns an existing live record on re-register). Deleting the blob means confirming no live record references it — across `content_hash` *and* any per-parent dedup pointers.
- **`parent_id` repair on parent tombstone.** Decide whether tombstoning a parent should null the children's `parent_id` (clean dangling refs at the cost of mutating descendant rows, which has its own HLC/sync implications) or leave them in place (stable refs to tombstones). Either policy can work; the choice should be made once and applied uniformly.
- **Strategy.** Eager-on-tombstone (cheap but interacts with sync settlement), periodic janitor pass (simpler reasoning but more code to schedule), retention-based (e.g. 30 days after tombstone). Probably periodic, but uncommitted.
- **Tombstone retention.** Once a blob is gone, the tombstone can in principle also be purged, but sync semantics require keeping it until all channels have observed it. Likely the same cutoff as the blob.

From doc id 14 (`functional-doc-cloud-data-server-2026-06-05.md`), Part 2 — Missing behaviors and Potential gaps (the `parent_id` integrity item is folded in here).

Revisit when: storage costs start to matter, or before any production-scale use, whichever comes first. Track here rather than in production-tracking because the project is pre-production today and the work isn't load-bearing until then.
