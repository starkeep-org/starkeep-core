# Plan: OCC retry for the Aurora DSQL data plane

## 1. Design principle (the crux)

DSQL raises a serialization conflict (`40001` / `OC000`/`OC001`) at COMMIT of any
statement or transaction that raced a concurrent writer. Retrying is only safe if
the **unit we replay is idempotent**. Two distinct cases:

- **Value-independent writes** — the bytes written don't depend on a value read
  earlier in the same logical op (full-row `put` of a caller-supplied record, sync
  snapshot apply, LWW upserts, tombstones with a caller-supplied timestamp). Safe
  to retry **the statement alone**.
- **Read-modify-write (RMW)** — the written value is computed from a just-read row
  (e.g. `PUT /data/records/:id` sets `version = existing.version + 1`). Retrying
  only the write replays a stale value and clobbers the concurrent winner (lost
  update). These must retry **the whole read→compute→write unit** so the re-read
  sees the committed state.

Retry therefore attaches at two granularities: statement-level in the adapter, and
unit-level around the handler's RMW routes.

## 2. The retry helper

- New file `packages/storage-aurora-dsql/src/occ-retry.ts` exporting
  `isRetryableDsqlConflict(err)` and `withOccRetry<T>(label, fn, opts)` (default
  ~6 attempts, exp backoff ~25ms→1s; OCC clears in ms, unlike the installer's
  minutes-long IAM-propagation budget).
- Re-export from `storage-aurora-dsql/src/index.ts`.
- The CDS handler bundles `@starkeep/*` packages, so it can import from here (it
  cannot import from the installer package at runtime).
- Point `admin-installer/src/retry-on-access-denied.ts` at the shared predicate to
  prevent drift (verify the installer esbuild bundle still resolves the import).

## 3. Idempotency audit — classification

Value-independent (statement-level retry is sufficient and safe):
- `adapter.put` (`INSERT … ON CONFLICT(id) DO UPDATE SET <all cols>`)
- `adapter.get` / `adapter.query` (read-only)
- `adapter.delete` (`UPDATE … deleted_at=$ts`, ts passed in)
- `adapter.putMetadata` / `getMetadata(ByIds)` / `deleteMetadata`
- applier `applyInsert/Update/Delete` (single upsert/update guarded by `updated_at` LWW)
- applier `scanSince` / `queryRows` (read)
- factory `insertRow/updateRow/deleteRow` (one applier statement + `emitLocalChange()`
  side effect that may fire twice on retry — harmless notification)
- handler `sync/exchange` (loop of `get`→`put` per record; LWW by value, `clock.receive`
  monotonic) — adapter-level `put` retry suffices
- `makeCloudClock`, `loadAccessGrants` (read)

Transaction bodies (retry the whole `BEGIN…COMMIT` / `SAVEPOINT…RELEASE`):
- `adapter.batch` — ops held in memory, each idempotent → whole txn replayable. **In scope.**
- `adapter.transaction(cb)` — idempotency depends on `cb`; retry replays `cb`. Document
  the "callback must be idempotent" contract. **In scope.** (No runtime callers today;
  wrapping is defensive.)

Read-modify-write (must retry the whole unit, re-reading):
- **handler `PUT /data/records/:id`** — `get` → `put(version = existing.version+1)`.
  The one true correctness hazard: statement-only retry causes a lost update.
- **handler `DELETE /data/records/:id`** — `get` (existence) → `delete(clock.now())`.
- **handler `POST /data/records`** — dup `SELECT` then `put` with `generateId()`/`clock.now()`;
  a rolled-back attempt commits nothing, so a fresh id on retry cannot duplicate. Keep
  `generateId`/`clock.now` inside the unit.

## 4. Concrete changes

1. `occ-retry.ts` (new) — predicate + `withOccRetry`.
2. `adapter.ts` — wrap each public method body in `withOccRetry`. For `batch`/`transaction`,
   wrap the entire `BEGIN…COMMIT` / `SAVEPOINT…RELEASE` block so a retry re-issues BEGIN.
   JSDoc note on `transaction()`: callback is replayed on conflict and must be idempotent.
3. `apply.ts` (applier) — wrap each write `client.query` in `withOccRetry`.
4. `api-handler.ts` — wrap the RMW route bodies (`POST`, `PUT`, `DELETE /data/records/:id`)
   in `withOccRetry`, re-reading inside. `sync/exchange` relies on adapter-level `put`
   retry. Confirm the pg-client wrapper's auth-only retry (`28000`/`28P01`) composes with
   the OCC retry above it (different classes/layers — it does).
5. `retry-on-access-denied.ts` (installer) — import the shared predicate.

## 5. New tests (fail without the retry, pass with it)

Extend `FakeClient` with fail-N-times-then-succeed keyed by regex, throwing a DSQL-OCC
shaped error (`{ code: "OC001" }` / "change conflicts with another transaction").

1. `occ-retry.test.ts` — retries on `OC*`/conflict messages; gives up after N; does NOT
   retry non-OCC errors (`23505`, generic).
2. `adapter.test.ts` additions — `put` succeeds after two injected `OC001`s (asserts 3
   attempts); `batch` replays the whole `BEGIN…COMMIT`; `transaction` replays the whole
   `SAVEPOINT…RELEASE`; non-OCC error still throws without retry.
3. `apply.test.ts` (new or existing) — applier insert/update/delete succeed after an
   injected OCC conflict.
4. Handler RMW correctness test (`cloud-data-server/__tests__`, via `fake-dsql.ts` +
   `__setDatabaseClientFactoryForTests`): `PUT /data/records/:id` raises `OC001` on the
   first upsert; between attempts a concurrent write bumps the row to `version+1`; assert
   the retried unit re-reads and yields `version = concurrent+1` (no lost update). Fails
   today (500) and against naive statement-only retry (stale version). Plus: non-OCC
   handler error still maps to 500.

Each test is written to fail against the current tree and pass once the wrapper lands.

## 6. Sequencing

1. `occ-retry.ts` + unit test.
2. Adapter (incl. batch/transaction) + applier + tests.
3. Handler RMW unit retry + lost-update test.
4. Installer predicate de-dup (verify bundle).
5. Full `pnpm test` on both packages.

Risks: over-broad predicate (mitigated by negative tests); nested retry multiplying
attempts (keep counts low); installer bundle resolution after import change (verify).

## 7. Outcome / deviations from plan

Implemented as planned, with two notable refinements:

- **Re-entrant `withOccRetry`.** Because the adapter's own `put`/`get`/`delete`
  now self-retry, a handler RMW unit that wraps them would have its inner write
  clobber the concurrent winner before the outer could re-read. Fixed by making
  `withOccRetry` re-entrant via `AsyncLocalStorage`: the OUTERMOST call owns the
  retry loop; nested calls run once and let the conflict bubble up. This is what
  makes the PUT lost-update test pass (re-read yields version 3, not stale 2).
  The RMW route bodies use `return await withOccRetry(...)` so the handler's
  `finally` (which closes the DB) runs only after the unit settles.

- **Installer predicate NOT de-duped (step 4 changed).** `admin-installer/src`
  has no dependency on `storage-aurora-dsql`, and adding one to share an 8-line
  predicate risks pulling the whole package into the installer's esbuild bundle
  and couples two deliberately-decoupled packages. Kept the two copies with an
  explicit cross-reference comment in each instead (the "leave the installer
  copy" branch §2 already sanctioned).

Tests: storage-aurora-dsql 43 passed (occ-retry 8, adapter 19, applier 2, +
existing); admin-installer 128 passed (incl. the handler lost-update + non-OCC
500 tests). `tsc --noEmit` and eslint clean on both packages.
