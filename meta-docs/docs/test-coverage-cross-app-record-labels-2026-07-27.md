# Test coverage: cross-app record labels

Date: 2026-07-27
Branch: `cross-app-record-labels` (both `starkeep-core` and `starkeep-apps`)
Status: **all identified gaps closed.** Everything below is implemented and green
except the AWS e2e leg, which needs a real account to run.

Companion to `plan-cross-app-record-labels-2026-07-27.md`. That plan describes what
was built; this describes what was untested about it, what changed in the production
code as a result, and where each behaviour is now pinned.

---

## 1. Two production changes came out of the review

The coverage pass surfaced two things that were not test problems.

### 1a. Label SQL was written twice, and its semantics three times

Both SQL adapters built the same label queries independently — same columns, same
`ON CONFLICT` set, same cursor predicate, same page-plus-one paging — differing only
in table name, `NULLS FIRST` spelling, and OCC wrapping. The in-memory mock then
re-implemented the ordering and cursor comparison a third time in TypeScript, and the
whole SDK suite runs against that mock. A mock that sorted nulls the other way would
have passed every offline test and disagreed with both real backends.

Consolidated into `@starkeep/storage-adapter`:

| New module | What it owns |
|---|---|
| `database/label-queries.ts` | Every label statement, built once from the caller's Kysely compiler. `LabelDialect` carries the only two things that differ (`table`, `spellOutNullsFirst`). |
| `database/label-row.ts` | The nine-column row shape and both conversions, previously duplicated per adapter. |
| `database/label-cursor.ts` (extended) | `compareLabelOrder` / `compareLabelScanOrder` / `isAfterLabelCursor` / `isAfterLabelScanCursor` — the order the mock now borrows instead of restating. |

`storage-adapter` gained a `kysely` dependency for this. Both concrete adapters
already depended on it, and it is the one package on both backends' dependency path.

### 1b. A repeated `(recordId, key)` in one batch was a cloud-only failure

Postgres/DSQL rejects a multi-row `INSERT … ON CONFLICT DO UPDATE` that touches one
row twice (`21000: cannot affect row a second time`). SQLite applies them in order and
keeps the last — verified directly. Nothing in the SDK, either data server, or
`planLabelWrites` de-duplicated, so a batch with a repeat **succeeded locally and would
have 500'd in the cloud**: the worst shape a divergence can take, because it passes
every test that runs offline.

Fixed in three places, deliberately:

- `dedupeLabelWrites` in protocol-primitives, applied by `planLabelWrites` and
  `planLabelRetractions` — so the row count a server reports is the row count written.
- `sdk.setLabels`, before chunking.
- `buildLabelUpsert` itself, which is the guarantee no caller can get wrong.

Last write wins, matching SQLite's existing behaviour and the row a caller would have
been left with.

### 1c. Smaller fixes made along the way

- **`MockDatabaseAdapter` ignored `isNull`/`isNotNull` filters** (fell through to
  `true`), so it returned tombstoned records and every SDK test was blind to soft
  deletion. Now implemented.
- **Photos' two resize paths were line-for-line copies** of the same label rules.
  Extracted to `photos/src/photos-lib/labels.ts` (`derivedKindOf`, `isThumbnail`,
  `canThumbnail`, `findThumbnailFor`, `PHOTOS_LABEL_KEYS`), used by the Next route, the
  cloud Lambda, and the record→AppImage mapper.
- **`e2e-aws` used `pg` and `@aws-sdk/dsql-signer` without declaring them**, so
  `npm run typecheck` failed at the repo root. Declared.
- Stale `label: null` column removed from the cloud test `recordRow` fixture.

---

## 2. Where each behaviour is now pinned

| Area | File | Notes |
|---|---|---|
| Shared label SQL, both dialects | `storage-adapter/__tests__/label-queries.test.ts` | Compiles every builder against SQLite **and** Postgres from one call site, so a change landing in one dialect shows as a diff. Pins `NULLS FIRST`, the expanded cursor predicate, `deleted_at` pinning, the dedupe, and `null` for an unsatisfiable query. |
| Cursors | `storage-adapter/__tests__/label-cursor.test.ts` | Round trips, null values, hand-edited tokens → `null` not a 500, and that reverse and scan tokens do not cross-decode. |
| Row serialization | `storage-adapter/__tests__/label-row.test.ts` | Includes `node_id` coming from `updatedAt`, not the row's own field. |
| Adapter contract | `storage-sqlite/__tests__/label-conformance.test.ts` | 30 cases × Mock and SQLite. Lives in storage-sqlite because it is the package with both implementations on its dependency path. Replaced the old SQLite-only `labels.test.ts`, which had become a duplicate. |
| DSQL adapter | `storage-aurora-dsql/__tests__/labels.test.ts` | What the adapter adds over the shared SQL: OCC retry converging on replay, whole-batch retract retry, and short-circuits that issue no SQL at all. |
| SDK chunking | `sdk/__tests__/sdk.test.ts` | The 3,000-row split, the chunked record-type lookup, one HLC per pass, dedupe, and that `findByLabel` does no grant filtering (it sits below the trust boundary). |
| Sync | `sync-engine/__tests__/labels.test.ts` | Cross-stream contiguous prefix under blob failure (both directions), the responder's halted-node skip, a backlog larger than one scan page, and the shared record/label round budget. |
| LDS | `apps/local-data-server/__tests__/labels.test.ts` | Reverse query over a partially-readable library (pages stay full, exhaustion finds every readable match), the orphan short page, create-path partial failure, dedup-hit skip. |
| LDS lifecycle | `apps/local-data-server/__tests__/label-lifecycle.test.ts` | Uninstall keeps rows, drops declarations; reinstalling with fewer keys leaves live rows on an undeclared key, where reads work, writes 400, and **retraction still succeeds**. |
| Cloud handler | `cloud-data-server/__tests__/labels.test.ts` | Reverse-index order restored after the record fetch, `labelValue`, hydration on the reverse path, `labelApps`, cursor round trip, orphan short page, all-access, `?app=` filter, create-path failure. |
| Installer DDL | `admin-installer/__tests__/dsql-ddl.test.ts` | Registry upsert, stale-key revocation (both branches), uninstall dropping declarations but never label rows. |
| Schema DDL | `admin-installer/__tests__/dsql-schema-init.test.ts` | **New file.** Guards the measured reverse-index column order and `INCLUDE`, the PUBLIC grants, and the DSQL constraints (one DDL statement per query, no PL/pgSQL). Nothing in CI covered this before; `initializeSharedSchema` only runs against a real endpoint. |
| Photos | `photos/__tests__/photos-labels.test.ts`, `photo-record-to-app-image.test.ts` | The rules both resize paths ask, and `derivedKind` including another app's identically-named key. |
| Real DSQL | `e2e-aws/src/journey.test.ts` | Write (flag + valued in one batch), registry read, hydration, presence and exact-value reverse queries, retraction. The only place the shipped label code meets a real cluster — the §3a/§3b POC ran hand-written SQL. |

---

## 3. Things found while doing this, not fixed

- **The local installer has no upgrade path.** `installLocal` returns early for an
  app that is already active, so re-posting a changed manifest is a no-op — grants,
  syncable tables and label keys all keep their original values. The DSQL installer
  (`dsql-ddl.ts`) *does* re-apply and revoke stale keys unconditionally. So a manifest
  that drops a label key has it revoked in the cloud and still writable locally until
  the app is uninstalled and reinstalled. Pre-existing and not label-specific; the
  lifecycle test documents the asymmetry and routes around it.
- **The local-data-server exposes no `DELETE /data/records/:id`.** The label cascade
  is reachable only through `sdk.data.delete` and the cloud handler, both covered.
  Noted in the LDS test file so the absence reads as deliberate.
- **The AWS e2e leg has not been run** — it needs a real account and a test stack.

---

## 4. Verification

- `npm run build`, `npm run typecheck`, `npm test` at the `starkeep-core` root: all green.
- `starkeep-apps`: photos (96 tests) green; `tsc --noEmit` clean, plus the photos e2e
  tsconfig; the photos Lambda bundle builds with the shared helper.
