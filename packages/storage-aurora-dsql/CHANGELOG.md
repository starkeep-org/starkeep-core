# @starkeep/storage-aurora-dsql

## 0.10.1

### Patch Changes

- Updated dependencies [1a883ca]
  - @starkeep/protocol-primitives@0.13.0
  - @starkeep/shared-space-api@0.10.1
  - @starkeep/storage-adapter@0.11.1
  - @starkeep/sync-engine@0.13.1

## 0.10.0

### Minor Changes

- 00a78b5: The app row query gains a `join` parameter, column operands (`{"eq":{"col":"<table>.<column>"}}`), `exists` and `not_exists` subqueries, `in` and `not_in` with a subquery, an explicit `eq` and a literal `not_in`. Joined columns come back under qualified keys such as `"tasks.title"`, and a query with `join` must name its columns in `select`. `order` gains a JSON spelling, `[{"col":"tasks.due","dir":"desc","nulls":"first"}]`, which can name a joined column. The flat spelling, `due.desc`, still parses for columns of the queried table, but it is deprecated: both data servers answer it with a `Deprecation` header and log one line per app. `flatOrderDeprecation` and `isFlatOrder` are new exports of `@starkeep/shared-space-api`. The manifest validator refuses the column names `exists` and `not_exists`, two tables with one name, and two columns with one name in one table. `parseQuery` takes an optional `{ tables }` argument that enables the multi-table forms; without it, they are refused.

### Patch Changes

- Updated dependencies [941c6fc]
- Updated dependencies [00a78b5]
  - @starkeep/sync-engine@0.13.0
  - @starkeep/storage-adapter@0.11.0
  - @starkeep/shared-space-api@0.10.0

## 0.9.0

### Minor Changes

- 7add5da: The sync apply path decides last-writer-wins inside its writes. `DatabaseAdapter.putSnapshot` is an upsert that replaces a row only with a strictly later `updatedAt`, and `putLabel` has the same guard; both resolve `true` when they wrote and `false` when a newer row was kept. Before this, the apply paths compared HLCs with a `get` and then wrote with an unconditional upsert in a separate transaction, so a concurrent round could land a newer row in between and the older write replaced it, after the newer one had raised its author's coverage. The responder and the requester now write through these methods and re-read the row when a write is kept out, and the requester no longer announces or counts a record whose snapshot was kept out. On DSQL the coverage raise is issued either way and records nothing after a skipped write. `put` keeps its unconditional behaviour for the local write paths. An adapter implementing `DatabaseAdapter` outside this repository needs a `putSnapshot`, and its `putLabel` must return a boolean.

### Patch Changes

- Updated dependencies [47e07bd]
- Updated dependencies [4838b92]
- Updated dependencies [7add5da]
- Updated dependencies [9ae5c68]
  - @starkeep/sync-engine@0.12.0
  - @starkeep/protocol-primitives@0.12.0
  - @starkeep/storage-adapter@0.10.0
  - @starkeep/shared-space-api@0.9.1

## 0.8.0

### Minor Changes

- 1460d5c: A record keeps its source file's own dates. `DataRecord` gains `originalCreatedAt` and `originalUpdatedAt`, ISO 8601 strings or null, and `createDataRecord` takes both as optional input. Both stores add the `original_created_at` and `original_updated_at` columns, and an existing SQLite database or DSQL cluster gains them when the data server starts. The records grammar can filter and order on both columns. Only the local folder watcher fills them, from the file's birth time and modification time.
- 5b57fa3: Row writes report what they did. `AppSyncableApplier.apply` takes optional write conditions and returns the changed-row count, plus a skip reason (`live`, `deleted`, `missing`, `stale` or `superseded`) for an app's own write that changed nothing. `superseded` marks a write that lost last-writer-wins to a newer stamp, and every route answers it with 409. `insertRow` accepts `ifAbsent`, which counts a deleted row as present. `updateRow` and `deleteRow` accept `ifUpdatedAt` for compare-and-set. All three return a `RowWriteResult` in place of a bare number. An update or a key-only delete now matches live rows only, so a patch no longer lands on a tombstone and a repeated delete no longer re-stamps one. `rowWriteResponse` maps a result to the HTTP status both data servers answer with, and its 404 carries `skipped: "missing"` so a client can tell a missing row from a missing route. `refuseMisplacedConditions` refuses a condition the route does not take, such as `ifUpdatedAt` on a `POST`, and both data servers answer it with 400. Both appliers take `probeKeyFor` and `requireInsertKey` from storage-adapter. `appSyncableWriteConformance` holds the cases each SQL applier runs.

### Patch Changes

- Updated dependencies [380bb3f]
- Updated dependencies [1460d5c]
- Updated dependencies [5b57fa3]
  - @starkeep/protocol-primitives@0.11.0
  - @starkeep/storage-adapter@0.9.0
  - @starkeep/shared-space-api@0.9.0
  - @starkeep/sync-engine@0.11.0

## 0.7.2

### Patch Changes

- Updated dependencies [a3a8ca5]
  - @starkeep/protocol-primitives@0.10.0
  - @starkeep/shared-space-api@0.8.1
  - @starkeep/storage-adapter@0.8.3
  - @starkeep/sync-engine@0.10.2

## 0.7.1

### Patch Changes

- c6fb61b: Both app-syncable appliers refuse a file-index row whose `created_at` is not a serialized HLC, through the new `requireWellFormedFileIndexRow`. The check covers a row a node registers itself and a row a peer pushes over sync. The sync engine treats the refusal as it treats any failed apply: the log names the row, the author's watermark holds, and the response lists the author in `haltedAuthors`.
- Updated dependencies [8dbd1c4]
- Updated dependencies [8dbd1c4]
- Updated dependencies [c6fb61b]
  - @starkeep/shared-space-api@0.8.0
  - @starkeep/protocol-primitives@0.9.0
  - @starkeep/storage-adapter@0.8.2
  - @starkeep/sync-engine@0.10.1

## 0.7.0

### Minor Changes

- 6f5c97c: `guardSingleFlight` wraps a DSQL client and flags a statement that starts while another is still running on the same client. In `"throw"` mode it refuses the statement and passes the refusal to an optional `onRefuse`, so a test can see one that a `catch` block swallowed; in `"warn"` mode it logs `[pg-overlap]` with the stack once per call site and lets `pg` queue the statement. `pg` 8 queues such statements with a stackless deprecation warning, and `pg` 9 will refuse them.

### Patch Changes

- 5e8767b: The owner-scope header now lists the `public_sharing` schema among the deployment's unscoped tables.
- Updated dependencies [d40562e]
- Updated dependencies [39e3d86]
  - @starkeep/sync-engine@0.10.0
  - @starkeep/protocol-primitives@0.8.0
  - @starkeep/shared-space-api@0.7.1
  - @starkeep/storage-adapter@0.8.1

## 0.6.0

### Minor Changes

- 317a926: The DSQL adapter and applier read sync coverage from per-author watermark tables instead of grouping every row the user owns. `shared.node_watermarks_records`, `shared.node_watermarks_labels` and each app schema's `_starkeep_node_watermarks` hold, per user, author and type or table, the highest `updated_at` that has landed. Every write to a synced table now runs in a transaction that raises its authors' entries from the rows it wrote. An entry never decreases, so an author whose rows were all superseded keeps its coverage. Each adapter and applier instance reads each table once until its next write.

  `guardNodeWatermarks` wraps a client and refuses a synced write outside a transaction, a commit that skipped its raise, any other write to the watermark tables, and savepoints. A type-scoped adapter narrows the watermark tables by type, as it narrows records and labels. The owner scope now accepts an `insert … select` into an owned table and selects the user in the owner column. An installed app whose watermark table is missing throws from `getNodeWatermarks`, so the exchange reports incomplete coverage rather than none. The DSQL bytes-watermark store's `save` now replaces the stored map, as the memory store does, by deleting the rows of authors the map omits.

  `shared-space-api` exports `NODE_WATERMARKS_TABLE` and reserves the name. `storage-adapter` replaces `buildLabelNodeWatermarks` with `buildNodeWatermarks`, which serves the grouped reads SQLite still uses. The type scope narrows labels by their denormalized `record_type` instead of a semi-join to records.

### Patch Changes

- Updated dependencies [317a926]
  - @starkeep/storage-adapter@0.8.0
  - @starkeep/shared-space-api@0.7.0
  - @starkeep/sync-engine@0.9.2

## 0.5.0

### Minor Changes

- 18b7a5f: `RecordTypeScopePlugin` narrows every records and labels read on a Kysely instance to a set of record types, so a mobile app's exchange sees only the types its manifest grants. Scans, watermarks and digests all compile through it and agree. `typeScopedCompiler` exposes the same narrowing to the adapter's raw queries.

### Patch Changes

- Updated dependencies [18b7a5f]
- Updated dependencies [18b7a5f]
  - @starkeep/protocol-primitives@0.7.0
  - @starkeep/sync-engine@0.9.1
  - @starkeep/shared-space-api@0.6.2
  - @starkeep/storage-adapter@0.7.1

## 0.4.3

### Patch Changes

- Updated dependencies [80c9a42]
- Updated dependencies [5247eda]
  - @starkeep/sync-engine@0.9.0
  - @starkeep/shared-space-api@0.6.1

## 0.4.2

### Patch Changes

- fcd80e9: The cloud signs no URL for a shared file that has not reached S3. `RecordAvailability` gains `awaiting-upload`, stand-in sizes and variant candidates carry `awaiting_upload: true` in place of a URL, and the single-record reads answer `409 AwaitingUpload`. `VariantCandidate` carries the child's `updatedAt`, which the cloud compares with Drive's bytes watermark. `verify()` reports `filesOwed` and `filesOwedCapped`: the files the peer is still owed, since rows now reach it ahead of their files.
- Updated dependencies [fcd80e9]
  - @starkeep/protocol-primitives@0.6.0
  - @starkeep/storage-adapter@0.7.0
  - @starkeep/shared-space-api@0.6.0
  - @starkeep/sync-engine@0.8.0

## 0.4.1

### Patch Changes

- Updated dependencies [e362220]
  - @starkeep/storage-adapter@0.6.0
  - @starkeep/sync-engine@0.7.0
  - @starkeep/shared-space-api@0.5.1

## 0.4.0

### Minor Changes

- Publish the engine changes made since the 0.4 package set (2026-08-02) and the 0.3 set (2026-07-29), which went unpublished: sync in bounded rounds with a delta scan, and the residency fixes; content-addressed shared records keyed on parent, filename and hash; metadata that syncs with its record; the shared query grammar; stand-ins and the reduced storage settings; record deletion, the deleted feed and blob reclamation; rows that travel ahead of their files; and per-user object keys, user-scoped cloud statements and device sign-in. Most of these change the wire format or the stored layout, so every node must run this set together.

### Patch Changes

- Updated dependencies
  - @starkeep/protocol-primitives@0.5.0
  - @starkeep/storage-adapter@0.5.0
  - @starkeep/shared-space-api@0.5.0
  - @starkeep/sync-engine@0.6.0
