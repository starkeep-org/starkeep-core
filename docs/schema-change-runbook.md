# Runbook: changing a column type without losing app data

## Scope

Handles a **declared column type change** on an installed app — the case DSQL
cannot do in place, because `ALTER TABLE ALTER COLUMN TYPE` fails with `0A000`
and both installers create tables `IF NOT EXISTS`.

Preserves **app-syncable data** by treating local as authoritative and letting
sync refill the cloud. Verified on Memo: 4,469 rows across six tables, three
simultaneous type changes (`real`→`double precision`, `text`→`timestamp`,
`integer`→`boolean`), zero rows lost.

**Does not cover** shared records, labels, or per-category metadata. Those live
only in `shared.*` and have no second copy to refill from — a change there needs
its own backup and restore.

## Steps

### 1. Confirm local is authoritative

- Sync to quiescence; confirm a further round applies **zero** rows.
- Compare cloud and local row counts per table. They should already match.

### 2. Snapshot and verify the snapshot

```bash
cp ~/.starkeep/data.db ~/.starkeep/backups/pre-change-$(date +%Y%m%d-%H%M%S).db
```

Verify it matches current — row counts **and** `max(updated_at)` per table. A
snapshot that has never been compared is not a backup.

### 3. Work out which engines actually change

Compare the old and new `pgColumnType` / `sqliteColumnType` output. SQLite is
often unchanged (it has no boolean and no timestamp type), in which case the
local tables need no drop at all and only the registry row is rewritten.

### 4. Land the code change

Manifest and the app's TypeScript types **in one commit**. Flipping the declared
type makes `tsc` enumerate every incompatible site; the manifest alone is the
silent version.

Record the test baseline before touching any test, and confirm the same counts
after. `expect(x).toBe(1)` is loosely typed and will not typecheck-fail — run
the suite.

### 5. Drop the cloud objects

Drop the app schema (`DROP SCHEMA app_<id> CASCADE`) and any shared tables whose
types change. Confirm afterwards that `shared.records`, `shared.record_labels`
and `shared.app_registry` are untouched.

### 6. Re-run the cloud install DDL

**"Redeploy" does not do this.** Only the infra steps carry `alwaysRun`, so
`run_dsql_ddl` is skipped whenever the ledger records it done.

Either clear the app's **entire** install ledger, or call `runAppInstallDdl`
directly with the app's manifest.

> Never clear a single ledger row. `run_dsql_ddl` depends on
> `attach_temp_install_ddl_policy`, which has no `alwaysRun`, so clearing the
> DDL row alone runs it with no `DbConnectAdmin` grant — an AccessDenied retry
> loop with no way out.

Verify: schema exists, column types are the new ones, and the
`app_syncable_namespaces` row carries `columns`.

### 7. Reinstall locally without dropping tables

`uninstallLocal` drops the syncable tables and `installLocal` returns early for
an `active` app, so reset the gate instead:

```sql
UPDATE shared_app_registry SET status = 'installing' WHERE app_id = '<id>';
DELETE FROM shared_app_install_steps WHERE app_id = '<id>';
```

Then reinstall through admin-web. Every step is idempotent and non-destructive:
tables and indexes are `IF NOT EXISTS`, grants/label-keys/namespace upsert, and
`create_app_registry_row` is skipped when a row exists so the HMAC secret
survives.

Verify: row counts unchanged, namespace row retyped, secret still present.

### 8. Refill and verify

Trigger a sync. The cloud reports empty coverage, the requester **replaces** its
cached peer watermarks rather than merging upward, and every row ships again.

Verify both:

- Row counts match table for table.
- **Values** match — floats byte-identical, booleans native, timestamps the same
  wall clock. Counts alone would not have caught float4 truncation.

## Gotchas

- **Every app's namespace row must be typed, or every app 500s.**
  `DsqlAppSyncableNamespaceStore.load()` reads all rows and throws on the first
  untyped one, so a stale row for one app breaks the others. Re-run the DDL for
  every installed app, not just the one being changed.
- **Read timestamps as `::text` when verifying.** `pg` and PGlite parse a naive
  timestamp with `new Date(...)`, which reinterprets it in the process zone —
  a verification script without `applyPgTypeParsers` reports a false offset.
- **Postgres normalizes the fraction**: `.210` renders as `.21`. Compare
  instants, not strings, unless the read path has re-canonicalized.
- **Precision already lost stays lost.** A value that round-tripped through a
  narrower column comes back rounded; fixing the column does not restore it.
