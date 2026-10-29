# Review: floored watermark reads (uncommitted, starkeep-core) — 2026-10-29

Scope: the uncommitted diff on branch `sync-engine-docs-rows-before-files` in `~/projects/starkeep/starkeep-core`. The diff implements option B from `~/projects/starkeep/findings-dsql-cost-idle-sync-polling-2026-10-28.md`. The DSQL watermark reads now take the requester's watermarks as a floor and use bounded seeks instead of a `GROUP BY` over the whole index.

## Problems found

1. **Narrowed (phone) exchanges may not get the savings, and the label shape may cost more than before.** Nobody has measured these shapes on DSQL. See "Finding 1".
2. **A fallback to the full read happens silently.** If the savings stop, the only sign is the DSQL bill. See "Finding 2".
3. **`buildNodeWatermarks` and `buildLabelNodeWatermarks` now build the same query under two names.** The new export has no caller outside its own module. See "Finding 3".
4. **Gap probes are correct only under C collation.** The helper sits in the generic `storage-adapter` package. See "Finding 4".

No correctness bug turned up. The omission contract holds in each of these places:

- `planNodeScans` already skips an author below the peer's watermark, so an omission cannot change a delta-scan plan.
- `coversFloor` re-reads whole whenever the union lacks an author at or above the floor. That re-read is the only case where an omission could understate coverage.
- An unknown author in a gap falls back to the grouped read, so the delta scan still ships that author's rows.
- The owner scope reaches every nested subquery. The compiled SQL below shows `user_id = $n` in each one, and the PGlite suite checks it against a second user.

## Verification run for this review

- The `pnpm test` unit suites pass for `storage-adapter` (164), `sync-engine` (579), `storage-aurora-dsql` (113) and `cloud-data-server` (436).
- `tsc --noEmit` passes for `storage-adapter`, `sync-engine`, `storage-aurora-dsql`, `cloud-data-server` and `storage-sqlite`.
- The new PGlite suite `~/projects/starkeep/starkeep-core/packages/storage-aurora-dsql/__tests__/integration/floored-watermarks.test.ts` passes (11 tests).
- The SQL below was compiled from the real builders and the real owner-scope and type-scope compilers by a throwaway script, not by hand.

## Old and new queries

### Old: one grouped read per table

The same shape served `shared.records`, `shared.record_labels` and every `app_<id>.<table>`. It read every index entry the user has in the table, and an exchange ran it twice per table: once to plan the delta scan and once for the coverage report.

```sql
SELECT node_id, max(updated_at) AS max_updated_at
FROM shared.records
WHERE shared.records.user_id = $1
GROUP BY node_id
```

### New: one statement of bounded seeks per table

`readNodeWatermarks` (`packages/storage-adapter/src/database/since-queries.ts`) builds the query below. The example uses a floor of `{node-a, node-b, node-c}`, and the authors are sorted in code-point order. The statement always returns exactly one row.

```sql
SELECT
  -- a<i>: each named author's max, only among rows at or above its floor
  (SELECT max(updated_at) FROM shared.records
     WHERE node_id = 'node-a' AND updated_at >= '0000000003e8:0000:node-a'
       AND user_id = $u) AS a0,
  (SELECT max(updated_at) FROM shared.records
     WHERE node_id = 'node-b' AND updated_at >= '0000000005dc:0000:node-b'
       AND user_id = $u) AS a1,
  (SELECT max(updated_at) FROM shared.records
     WHERE node_id = 'node-c' AND updated_at >= '0000000007d0:0000:node-c'
       AND user_id = $u) AS a2,
  -- g<i>: does any author live in the gap before, between, or after them?
  (SELECT node_id FROM shared.records
     WHERE node_id < 'node-a' AND user_id = $u
     ORDER BY node_id LIMIT 1) AS g0,
  (SELECT node_id FROM shared.records
     WHERE node_id > 'node-a' AND node_id < 'node-b' AND user_id = $u
     ORDER BY node_id LIMIT 1) AS g1,
  (SELECT node_id FROM shared.records
     WHERE node_id > 'node-b' AND node_id < 'node-c' AND user_id = $u
     ORDER BY node_id LIMIT 1) AS g2,
  (SELECT node_id FROM shared.records
     WHERE node_id > 'node-c' AND user_id = $u
     ORDER BY node_id LIMIT 1) AS g3
```

The code interprets the row as follows:

- If every `g<i>` is null, the code returns each non-null `a<i>`. A null `a<i>` means the author sits below its floor, and the code omits that author.
- If any `g<i>` is non-null, the requester has never seen that author. The code then runs the old grouped read.
- An empty floor, or a floor with more than 256 authors, also goes straight to the grouped read.

The in-process transport (`packages/sync-engine/src/transports/in-process-transport.ts`, `readCoverage` and `coversFloor`) runs this statement for every table on the channel and takes the union. It then checks that every author the requester named came back at or above its floor. If any author did not, the transport runs `readCoverage(undefined)`, which repeats the old grouped reads.

### New, on a type-scoped (phone) adapter

On a type-scoped adapter, the type-scope plugin adds a predicate to every subquery. On `shared.records`, each `a<i>` and `g<i>` gains `AND type IN ($t1, $t2)`. On `shared.record_labels`, each subquery gains a semi-join instead:

```sql
(SELECT max(updated_at) FROM shared.record_labels
   WHERE node_id = 'node-a' AND updated_at >= '…:node-a'
     AND record_id IN (SELECT id FROM shared.records
                        WHERE type IN ($t1) AND user_id = $u)
     AND user_id = $u) AS a0,
-- …repeated in every a<i> and g<i>
```

## Finding 1 — narrowed exchanges are unmeasured, and one shape may regress

The live `EXPLAIN ANALYZE` numbers in the cost findings ("Implementation status", "Verification") cover only unscoped exchanges. The findings' claim under "Narrowed mobile exchanges" holds for some narrowed shapes and fails for others:

- **`type` is not in the `(user_id, node_id, updated_at)` index.** A phone's floor for an author reflects only that author's in-scope rows. Suppose a desktop author writes 5,000 markdown records after its last image. On every phone tick, the `a<i>` probe for that author reads all 5,000 rows and fetches each one from the table to test `type`. That cost grows with the author's out-of-scope history. The old grouped read also paid it, so the probe is never worse than before. It just isn't the near-zero cost the findings predict.
- **An author with only out-of-scope rows sits in a gap.** The `g<i>` probe has no `updated_at` bound, so it walks that author's entire range and finds nothing in scope.
- **Narrowed label reads may cost more than before.** The old narrowed label read had one `IN (SELECT id FROM records …)`. The new statement has 2N+1 of them, where N is the number of authors in the floor. If DSQL plans each as a hashed subplan, each one reads every in-scope record the user has, which could make this read several times more expensive than the old one. If DSQL plans each as a nested-loop lookup on the records primary key, the cost is negligible. Only `EXPLAIN ANALYZE` on DSQL can settle which plan it picks.

**Suggested action:** before deploy, run the type-scoped records and labels statements under `EXPLAIN ANALYZE` against the live cluster with a phone-shaped floor. Correct the findings' "Narrowed mobile exchanges" bullet to match the result. Phone exchanges are about 6% of ticks, so a regression only on the label read is tolerable, but nobody should assume one either way.

## Finding 2 — the fallback to the full read is silent

The savings depend on one invariant: the floor names every author the responder holds within the exchange's read scope. When the invariant breaks, every tick falls back to the grouped read, plus the probe statement that came first. Correctness is unaffected, but nothing logs the fallback. Neither `readNodeWatermarks` (a gap author) nor the transport (`!coversFloor`) reports that it happened.

**Suggested action:** emit one `console.warn` line per fallback with the table and the reason ("gap author", "floor too wide", "behind on N authors"). The DSQL bill would then not be the first signal of a regression. A first sync or a new device should log once and then go quiet, which makes a persistent line easy to spot in CloudWatch.

### On your question: could a responder withhold rows in future?

Requesters never ask for things they won't be given. Two facts make that hold by construction:

- **The requester's watermark map advances only over rows the responder shipped.** In `sync-engine.ts`, `nextOwnWatermarks` advances only over `ownSafeAdvance`, which holds rows that arrived from the peer and applied. Repair floors only ever *lower* the advertised values.
- **The system already forbids post-filtering an exchange.** The header of `packages/storage-aurora-dsql/src/type-scope.ts` states the rule: a watermark or digest computed over rows the requester never receives "would make the two sides disagree forever." Narrowing must happen in the read scope (the Kysely plugin), so every read the exchange makes sees the same library. Phone narrowing works this way today.

Withholding rows is therefore not a new restriction that this change introduces. A future post-filter that skipped the read scope would already break the coverage watermark and the digests. The floored read adds one more way for that mistake to show up: silent loss of the savings rather than wrong data. Finding 2 exists so that this symptom gets logged.

## Finding 3 — duplicate builders and an unneeded export

- `buildNodeWatermarks(k, table)` and `buildLabelNodeWatermarks(k, dialect)` now compile the same SQL. After this change, only `storage-sqlite` and a test call `buildLabelNodeWatermarks`.
- `packages/storage-adapter/src/index.ts` now exports `buildNodeWatermarks`, but only its own module calls it.

**Suggested action:** stop exporting `buildNodeWatermarks`, or have `storage-sqlite` call it for labels and delete `buildLabelNodeWatermarks`. The `buildLabelNodeWatermarks` reference in the `packages/sync-engine/src/reaper.ts` header would then need to change. Either option is small, and both keep the package surface to what callers use.

## Finding 4 — the gap partition depends on collation

The probes cover the whole key space only if the database orders `node_id` the same way `compareCodePoints` does. If the orders differ, an author can fall outside every probe. `planNodeScans` would then skip that author, and the responder would never ship its rows. That failure is silent loss, not extra cost. DSQL supports only C collation, and the comment on `compareCodePoints` says so, so nothing is wrong today. The risk is reuse: `readNodeWatermarks` is a public export of the generic `storage-adapter` package.

**Suggested action:** add one sentence to the `readNodeWatermarks` doc comment saying that a caller must use a byte-ordered (C) collation on `node_id`. Code changes are optional.

## Nits

- In `readNodeWatermarks`, the gap check runs `authors.every(… g<i> …)` and then tests `g<authors.length>` separately. A single check over `0..authors.length` would be easier to read.
- When `coversFloor` fails, an exchange pays for the floored statement, the delta scan's own floored statement, and the full grouped reads. The cost matches the old one plus the probes, and the case is rare. No change is needed.

## Branch name

`sync-engine-docs-rows-before-files` describes the two commits already on the branch, not this diff. Commit `4faaac99` ("Correct sync-engine comments that describe rows and files as coupled") fixed comments left over from `dcebe6ad` (2026-10-14). Since that change, a round applies every row before it downloads any file: rows before files. The comments still described rows and files as coupled, and they sent a Photos Mobile import gate down the wrong path. Commit `b73f0c74` added the empty changeset for that docs-only commit.

The floored-watermark work is unrelated to those commits. It probably belongs on its own branch, such as `dsql-floored-watermarks`, so that each commit's history stays readable.
