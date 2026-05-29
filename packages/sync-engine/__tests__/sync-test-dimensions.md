# Sync Test Dimensions

Dimensions of variation for generating sync tests. Each test is a combination of
initial state (cloud node A, local node B), a triggering operation, and an expected
final state on both sides. Scope: 1 local node + 1 cloud node only.

---

## Dimension 1: Initial record presence

Where a record exists before any operation:

| Label | Cloud has it | Local has it |
|---|---|---|
| `cloud-only` | yes | no |
| `local-only` | no | yes |
| `both-same` | yes (identical) | yes (identical) |
| `both-diverged` | yes (different `updatedAt`) | yes (different `updatedAt`) |
| `neither` | no | no |

## Dimension 2: Tombstone state

`deletedAt` presence per side, independently:

- `not-deleted` — no `deletedAt` on either side
- `cloud-deleted` — cloud has `deletedAt` set, local does not
- `local-deleted` — local has `deletedAt` set, cloud does not
- `both-deleted` — `deletedAt` set on both (same or different timestamps)
- `conflict-deleted-vs-updated` — one side deleted it, the other updated it after (HLC determines winner)

## Dimension 3: Blob state

Whether the blob referenced by `objectStorageKey` is present in each storage layer. For blob-bearing records, this is equivalent to per-side residency (see `packages/sync-engine/src/residency.ts` and the "Per-record residency" section of `system-design.md`):

- `no-blob` — record has no blob (only applicable to `app-row`, which carries no file; included here for completeness)
- `cloud-has-blob` — cloud-side blob present (cloud is Resident); local-side blob absent (local is Staged for this record)
- `local-has-blob` — local-side blob present (local is Resident); cloud-side blob absent (cloud is Staged)
- `both-have-blob` — both sides have the blob (both Resident — normal steady state)
- `neither-has-blob` — record row exists on at least one side but neither side has the blob (both Staged; e.g. the record metadata propagated before either side received the file)

Out-of-band degenerate states ("record references a key that was deleted from storage out of band") are intentionally not modeled — see `system-design.md` for the residency invariant that excludes them.

## Dimension 4: Watermark state

The sync bookkeeping state before the operation:

- `zero` — fresh start, no sync has ever happened (empty watermarks)
- `partial` — some records synced, watermarks behind the latest record
- `current` — watermarks fully caught up; the next exchange would be a no-op
- `cloud-reset` — cloud watermarks wiped (simulates cloud-side reinstall or DSQL restore)
- `local-reset` — local watermarks wiped (simulates local SQLite wipe / new device)

## Dimension 5: Data type

- `shared-record` — a record in `shared.records`; always carries a blob in the shared S3 namespace
- `app-record` — a record in an app-specific records index; may or may not carry a blob in that app's S3 namespace (apps choose per record)
- `app-row` — a row in an app-specific syncable metadata table (DB-only, never blob-bearing)

## Dimension 6: Record count / batch shape

- `single` — one record in play
- `multi-homogeneous` — multiple records all from the same nodeId (tests per-nodeId ordering)
- `multi-mixed-nodes` — records carrying different nodeIds in their HLC timestamps (tests watermark fan-out)
- `exceeds-page-limit` — more records than the 2000-record page size (tests `hasMore` + multi-round convergence)

---

## Operation Dimensions

### Dimension 7: Triggering operation

What action is taken to drive the state change:

Operations are parameterized by side (`local` | `cloud`) and target the data type from Dimension 5:

- `insert` — side writes a new record/row (assigns new HLC)
- `update` — side updates an existing record/row (bumps `updatedAt`)
- `soft-delete` — side sets `deletedAt`
- `concurrent-update-both-sides` — both sides update the same record/row before any exchange (LWW race)

The full operation key is `{side}-{verb}` × data type (e.g. `local-insert` on `app-record`, `cloud-soft-delete` on `app-row`). Both `local` and `cloud` are valid sides for all three data types — cloud-resident apps (admin tools, other devices' cloud-side processes) can originate `app-record` and `app-row` writes just as cloud can originate `shared-record` writes.

### Dimension 8: Exchange count

How many `exchange()` rounds are run after the operation:

- `zero-rounds` — no exchange run; verify pre-sync isolation
- `one-round` — single exchange; verify what converges immediately
- `two-rounds` — second exchange is a no-op; verify idempotency and watermark stability
- `until-converged` — loop until `hasMore = false`; verify eventual full convergence

### Dimension 9: Network / transport failure mode

What goes wrong during the exchange, if anything:

- `no-failure` — clean exchange
- `fail-before-request` — transport throws before sending anything
- `fail-after-send-before-response` — request sent, no response received (timeout); tests that local state stays consistent with what was actually applied
- `blob-upload-fails` — `fileSyncEngine.transferFile()` fails for one record mid-batch; tests per-nodeId contiguous-prefix blocking
- `blob-upload-fails-middle` — blob upload fails for record N in a sequence; records N+1..end from same nodeId must not ship
- `blob-download-fails` — inbound blob pull fails; record metadata is applied but own watermark must not advance past the failed record
- `partial-response-truncated` — response arrives with `hasMore: true`; subsequent round picks up remainder

### Dimension 10: Failure recovery

When a failure mode (Dimension 9) is set, this sub-axis describes whether it clears on retry:

- `transient` — the failure occurs once, then subsequent attempts succeed; tests retry/resume paths
- `persistent` — the failure occurs on every attempt for the duration of the test; tests that local state stays consistent and watermarks do not advance past the failure point

Only meaningful when Dimension 9 ≠ `no-failure`. `persistent` is incompatible with `until-converged` (would never terminate).

---

## Cross-cutting combinations worth generating

The test matrix is not fully combinatorial. The interesting cells are:

1. **(initial presence) × (operation)** — e.g. `cloud-only` + `local-insert` of a conflicting record
2. **(tombstone state) × (one-round exchange)** — verify deletions propagate correctly in each direction
3. **(blob state) × (blob-upload-fails / blob-download-fails)** — verify the contiguous-prefix rule holds per blob failure type
4. **(watermark state = local-reset or cloud-reset) × (multi-homogeneous)** — verify full re-sync from zero
5. **(concurrent-update-both-sides) × (two-rounds)** — verify LWW winner is stable after second round
6. **(exceeds-page-limit) × (until-converged)** — verify multi-round pagination lands all records exactly once
7. **(app-syncable-row) × (conflict-deleted-vs-updated)** — verify LWW on `timestamp` field for app rows
