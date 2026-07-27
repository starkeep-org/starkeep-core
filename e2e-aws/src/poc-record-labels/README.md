# POC — cross-app record label schema

Two throwaway experiments backing the cross-app-record-labels plan. Both are **done**;
this directory is kept because the plan cites its numbers.

| Experiment | Question | Answer | Runner |
| --- | --- | --- | --- |
| §3a | row-per-key vs one jsonb column per `(record, app)` | row-per-key, decisively | `run.ts`, `scale.ts` |
| §3b | is the proposed reverse *index shape* viable on DSQL? | yes on both counts | `verify-index.ts` |

## §3a — row-per-key vs jsonb

Throwaway experiment backing §3a of
`meta-docs/docs/plan-cross-app-record-labels-2026-07-27.md`: does DSQL's new `jsonb`
support (May/June 2026) make "all of one app's labels for a record in one jsonb column"
a better layout than one row per `(record, app, key)`?

**Answer: no.** DSQL supports every jsonb *operator* we'd want but cannot index a jsonb
column by any route, so label filtering degrades to a linear scan. Full results in the
plan doc.

## Running it

This is **not** part of the vitest journey (the runner only picks up `src/**/*.test.ts`).
It needs a **disposable** DSQL cluster — `POC_DSQL_CLUSTER` has no default precisely so
it can never be pointed at a deployment's cluster by accident.

```bash
# 1. Create a throwaway cluster
aws dsql create-cluster --region us-east-2 --no-deletion-protection-enabled \
  --tags "starkeep:purpose=label-schema-poc,starkeep:disposable=true"

# 2. Wait for ACTIVE, then run
POC_DSQL_CLUSTER=<identifier> pnpm exec tsx src/poc-record-labels/run.ts
POC_DSQL_CLUSTER=<identifier> pnpm exec tsx src/poc-record-labels/scale.ts
POC_DSQL_CLUSTER=<identifier> pnpm exec tsx src/poc-record-labels/verify-index.ts

# 3. Delete it — DSQL bills storage + DPU
aws dsql delete-cluster --region us-east-2 --identifier <identifier>
```

Credentials come from the ambient AWS profile, same as the journey suite.

## What each file does

| File | Role |
| --- | --- |
| `connect.ts` | admin connection via `DsqlSigner`, error-capturing `tryQuery`, timing helpers |
| `schema.ts` | both candidate tables + their indexes, following the DSQL DDL rules in `dsql-schema-init.ts` |
| `seed.ts` | identical logical data into both designs: 20k records, one common key, one rare key, a second app on 25% |
| `run.ts` | E1–E7: jsonb operators, jsonb indexability, reverse lookup, forward lookup, OCC contention, txn limits, row counts |
| `scale.ts` | gives the jsonb design its best shot (covering `INCLUDE` index) and grows the library 20k → 120k to test whether its cost scales |
| `reverse-index.ts` | §3b: the two-table setup that answers whether `INCLUDE` is accepted and whether `deleted_at IS NULL` is a scan key |
| `verify-index.ts` | §3b runner |

## Headline numbers — §3a (us-east-2, 2026-07-27)

Reverse lookup — "first 50 records where app `alpha` set a **rare** key", DSQL-side
`EXPLAIN ANALYZE` execution time:

| Records | row-per-key | jsonb + covering index |
| --- | --- | --- |
| 20k | 3.28 ms | 100 ms |
| 60k | 3.34 ms | 269 ms |
| 120k | 3.40 ms | 518 ms |

Row-per-key is flat (indexed seek); jsonb is linear (~4.3 µs/row scanned). For a
**common** key the two tie, because `LIMIT 50` is met within the first ~64 rows — jsonb's
weakness is specific to selective filters.

Other findings: `jsonb_set` / `||` / `-` / `?` / `@>` / `ON CONFLICT DO UPDATE` all work;
`b-tree on jsonb`, `USING gin`, and expression indexes are all rejected by DSQL, while
`INCLUDE (labels)` is accepted; two concurrent `jsonb_set`s of *different keys on the same
row* fail with `OC000`, whereas the same writes as separate rows both commit; a 3,000-row
insert succeeds on a table with two secondary indexes and 3,001 fails, confirming index
entries don't count against the row limit.

## Headline numbers — §3b (us-east-2, 2026-07-27)

Does `(app_id, key, deleted_at, value, record_id) INCLUDE (record_type)` work on DSQL?
**Yes, both halves.**

`INCLUDE` is accepted on a regular b-tree, and the reverse query plans as an **`Index Only
Scan`** with `Projections: value, record_id, record_type` and no table lookup at all — so
the read-grant filter on `record_type` is evaluated inside the index scan rather than after
fetching records.

`deleted_at IS NULL` is a **scan key**, not an in-range filter. Two tables, identical data
(20 live rows behind 20,000 tombstones on one key), differing only in whether `deleted_at`
is a key column:

| | `deleted_at` indexed | control (no `deleted_at`) |
| --- | --- | --- |
| index entries scanned | **20** | **20,040** |
| DSQL execution time | **0.99 ms** | 30.2 ms |
| tombstones | never entered the range | `Rows Removed by Filter: 952`, post-heap-lookup |

**Measure DSQL-side, not wall clock.** Round-trip wall time for the *same* control query
came out 695 ms / 107 ms / 66 ms across three runs (cold vs warm cache) — noise large
enough to hide a 30× real difference. `verify-index.ts` parses `Execution Time` and the
scanned-row counts out of `EXPLAIN ANALYZE` for exactly this reason.
