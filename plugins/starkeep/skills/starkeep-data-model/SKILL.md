---
name: starkeep-data-model
description: Use before designing or porting a Starkeep app's data, to put each fact in the right place (record, metadata, label, app table, scratch) and to stay inside what the row API can and cannot do.
when_to_use: Designing or porting a schema (especially from Postgres); choosing between a label, per-category metadata and an app table; writing a `where`/`order`/`aggregate` query; seeding data; "why is my filter a 400", "why do I get two values for one label", "why did my insert overwrite a row".
---

# Starkeep data model

The docs are the source of truth. This skill routes you to them, lists the
limits in one place, and covers what the docs do not (row writes). Every line
names the doc section or source file that states it. Read the linked section
before you rely on a rule here.

Primary reading:

- [How data is classified](../../ref/docs/system-design.md#how-data-is-classified)
- [§6 App-specific syncable data](../../ref/docs/authoring-an-app.md#6-app-specific-syncable-data)
  and [§6a Querying your app's tables](../../ref/docs/authoring-an-app.md#6a-querying-your-apps-tables)
- [§9 Cross-app labels](../../ref/docs/authoring-an-app.md#9-cross-app-labels)

## Where data lives

Ask first: **is the fact derivable from the file's bytes?** Then: **who is the
audience, other apps or only your app?**
([Three places a fact about a record can live](../../ref/docs/system-design.md#three-places-a-fact-about-a-record-can-live)).

1. **The user's content is a shared record.** One file per item, indexed by
   `shared.records`, typed by a fixed `<category>/<format>` id from the
   platform registry (`image/jpeg`, `document/markdown`). Apps cannot invent
   types or categories. A bare category such as `"image"` is **not** a record
   type and not a grant key; grants are per exact type, so declare every type
   you touch in `fileAccess.types`
   ([Shared data](../../ref/docs/system-design.md#shared-data);
   [§5, the type granularity note](../../ref/docs/authoring-an-app.md#5-write-a-data-client)).
   Shared records outlive your app's uninstall.
2. **Facts derivable from the file are per-category metadata.** Width, height,
   capture time, EXIF. Platform-owned columns only, never app commentary. Writing
   them needs `metadataWrite: true` on the `fileAccess` entry
   ([Shared data](../../ref/docs/system-design.md#shared-data);
   [§5](../../ref/docs/authoring-an-app.md#5-write-a-data-client);
   `metadataWrite` in
   [`packages/admin-manifest/src/schema.ts`](https://github.com/myleshenderson/starkeep-core/blob/main/packages/admin-manifest/src/schema.ts)).
3. **An assertion meant for other apps is a label.**
   ([§9](../../ref/docs/authoring-an-app.md#9-cross-app-labels);
   [Shared data](../../ref/docs/system-design.md#shared-data))
   - Keys must be declared in `infraRequirements.labelKeys`, max 64 per app
     (`labelKeys: z.array(labelKeySchema).max(64)` in
     [`schema.ts`](https://github.com/myleshenderson/starkeep-core/blob/main/packages/admin-manifest/src/schema.ts)).
   - **A key is a set. `POST /data/labels` adds.** Writing `count=4` over
     `count=3` leaves both, and you read back two answers. To _update_, use
     `POST /data/labels/values`, which sets the key to exactly the given values
     atomically (empty `values` clears it). Retract with
     `POST /data/labels/retract`.
   - No NULL: a bare flag is the empty string `""`.
   - Values are at most 128 bytes and at most 32 per key per record
     (`LABEL_VALUE_MAX_BYTES`, `LABEL_VALUES_PER_KEY_MAX` in
     [`packages/protocol-primitives/src/records/labels.ts`](https://github.com/myleshenderson/starkeep-core/blob/main/packages/protocol-primitives/src/records/labels.ts)),
     matched by equality only.
   - Writing a label needs only a `read` grant. Every app that can read the
     type sees every app's labels on it, so private state in a label is
     published state.
4. **Your app's own state is an app-specific syncable table or file.** Captions,
   preferences, your own taxonomy. Declared under
   `infraRequirements.appSpecificSyncable`; a table becomes
   `<appId>_syncable_<name>` locally (`app_<appId>.<name>` in the cloud), files
   live under the app's `syncable/` prefix. It syncs only to places where your
   app is installed, and it is **deleted at that location when the app is
   uninstalled**
   ([App-specific data](../../ref/docs/system-design.md#app-specific-data);
   [§6](../../ref/docs/authoring-an-app.md#6-app-specific-syncable-data)).
5. **Non-syncable scratch is yours to manage.** The platform provides no managed
   scratch namespace. By convention it lives at
   `$STARKEEP_DIR/app-local/<appId>/`, and the platform neither enumerates nor
   cleans it on uninstall. Keep it out of `shared/...` and `apps/<appId>/...`
   ([App-specific data](../../ref/docs/system-design.md#app-specific-data);
   the `starkeepAssetsDir` comment in
   [`packages/app-client/src/paths.ts`](https://github.com/myleshenderson/starkeep-core/blob/main/packages/app-client/src/paths.ts)).

If you are unsure between 3 and 4: a caption is the app talking to itself (app
table); "I have OCR text for this" is the app talking to other apps (label).

## Row API: grammar and limits

Grammar: [§6a](../../ref/docs/authoring-an-app.md#6a-querying-your-apps-tables)
for your tables; the same grammar answers
[§9a metadata and labels](../../ref/docs/authoring-an-app.md#9a-querying-metadata-and-labels)
and [§9b records](../../ref/docs/authoring-an-app.md#9b-querying-records);
deletions are [§9c](../../ref/docs/authoring-an-app.md#9c-finding-out-what-was-deleted).
The parser is
[`packages/shared-space-api/src/query/parse.ts`](https://github.com/myleshenderson/starkeep-core/blob/main/packages/shared-space-api/src/query/parse.ts)
(`parse.ts` below), shared by the local and cloud servers.

**Reading**

- `where` operators are exactly `lt lte gt gte ne in is prefix like`, joined
  with **AND**. There is no `or`: issue two requests and merge (§6a; `ALL_OPS`
  in `parse.ts`). Ordered comparisons refuse `blob` and `boolean` columns.
- An unrecognized top-level parameter is a 400, not ignored (§6a). Column names
  go under `where`, `select` and `order`.
- `limit` defaults to 30 and a value above 500 is a 400 (`DEFAULT_LIMIT`,
  `MAX_LIMIT` in `parse.ts`). An `in` list takes at most 500 values
  (`MAX_IN_LIST` in `parse.ts`).
- `GET /data/records` defaults to 100 per page locally and 50 in the cloud, and
  _clamps_ a `limit` above 500 instead of refusing it (§9b rule 1;
  `boundedLimit` in
  [`packages/shared-space-api/src/query/records-plan.ts`](https://github.com/myleshenderson/starkeep-core/blob/main/packages/shared-space-api/src/query/records-plan.ts)).
- **Page until the token is null**: `page_token` on the grammar routes,
  `nextCursor` on `/data/records`. `truncated` can come from the row limit or
  from a 4 MB response budget, so a short page is not the end (§6a "Five
  things" 3–4; `RESPONSE_BUDGET_BYTES` in
  [`packages/storage-adapter/src/database/app-query.ts`](https://github.com/myleshenderson/starkeep-core/blob/main/packages/storage-adapter/src/database/app-query.ts)).
- `aggregate` functions are `count sum avg min max` (`AGGREGATE_FNS` in
  `parse.ts`). With `aggregate`, `select` **is** the GROUP BY list. `sum`/`avg`
  over zero rows is `null`, not `0`, and empty groups are omitted, not returned
  as zero (§6a "Five things that surprise people", 1–2).
- Label queries (`GET /data/labels`) must pin `app_id` and `key` in `where`. A
  category in which you hold no type is a **403**, not an empty page. You only
  ever see rows whose record type you were granted (§9a rules 1–3).

**Declaring tables** (§6;
[`packages/admin-manifest/src/schema.ts`](https://github.com/myleshenderson/starkeep-core/blob/main/packages/admin-manifest/src/schema.ts))

- Column types are exactly `integer bigint real text blob timestamp boolean`
  (`LOGICAL_COLUMN_TYPES` in
  [`packages/protocol-primitives/src/types/core-types.ts`](https://github.com/myleshenderson/starkeep-core/blob/main/packages/protocol-primitives/src/types/core-types.ts)).
  No json, uuid, numeric or array type.
- `timestamp` is text holding canonical ISO-8601 UTC at millisecond precision,
  exactly what `Date.prototype.toISOString()` produces; any other spelling is
  rejected on write (§6).
- `boolean` takes `true false 0 1` and reads back `true`/`false`; it has no
  ordering, so `order`, `min`, `max` and the comparisons refuse it (§6).
- `updated_at` and `deleted_at` are reserved column names
  (`RESERVED_SYNC_COLUMNS` in `schema.ts`). Pick another name, such as
  `updated_on`.
- **Indexes are declarable.** `indexes[]` on a table is an ordered column list
  (1–8 columns). There is no `unique` and no partial index; uniqueness is the
  primary key's job (`syncableTableIndexSchema` in `schema.ts`; §6). A filter
  or grouping without a matching index is a full scan, so declare one for every
  filter you issue.

**Writing rows** — not covered in the docs; §6a documents only `GET`. The
routes below are taken from the example client and the server:

| Call                                          | Effect                                              |
| --------------------------------------------- | --------------------------------------------------- |
| `POST /app-data/db/<table>` `{row}`           | Writes **one** row; upserts on the primary key      |
| `PATCH /app-data/db/<table>` `{where, patch}` | Sets the `patch` columns on the row `where` names   |
| `DELETE /app-data/db/<table>` `{where}`       | Tombstones the row `where` names (the delete syncs) |

Sources: `saveNote`, `patchNote`, `deleteNote` in
[`example-app/web/src/browser/api.ts`](https://github.com/myleshenderson/starkeep-core/blob/main/example-app/web/src/browser/api.ts);
the `/app-data/` branch in
[`apps/local-data-server/server.ts`](https://github.com/myleshenderson/starkeep-core/blob/main/apps/local-data-server/server.ts);
`insertRow`, `updateRow`, `deleteRow` in
[`packages/shared-space-api/src/app-syncable/factory.ts`](https://github.com/myleshenderson/starkeep-core/blob/main/packages/shared-space-api/src/app-syncable/factory.ts);
`applyInsert` in
[`packages/storage-sqlite/src/app-syncable/apply.ts`](https://github.com/myleshenderson/starkeep-core/blob/main/packages/storage-sqlite/src/app-syncable/apply.ts);
`requireKeyedWhere` in
[`packages/storage-adapter/src/database/app-syncable-rows.ts`](https://github.com/myleshenderson/starkeep-core/blob/main/packages/storage-adapter/src/database/app-syncable-rows.ts).

What that means for your design:

- **Every POST is an upsert.** A row with an existing primary key overwrites the
  columns you sent (last writer wins on `updated_at`) and clears any tombstone
  on it. Columns you did not send keep their old values. There is no "insert
  only if absent" (`applyInsert`).
- **One row per call.** The body takes a single `row`; there is no multi-row
  body and no transaction.
- **PATCH and DELETE address one row**: their `where` is column-to-value
  equality and must name every primary-key column. An empty `where`, or one
  naming only part of the key, is refused; the operators of the read grammar do
  not apply here (`requireKeyedWhere`; the matching `=` in `applyUpdate`). Both answer
  `{changes: 1}` whether or not a row matched (`updateRow`/`deleteRow` return a
  constant), so do not read it as a row count.
- Values are checked against the declared column types on every write
  (`validateRow` in `factory.ts`).
- Consequence: a "check whether the seed row exists, then insert" step is a
  race, and two writers that both "claim" a row both succeed. Make every write
  idempotent: derive the primary key deterministically from what the row is
  (for example `<recordId>` or `<deckId>:<cardId>`) so that a repeat write
  lands on the same row with the same content.

## Postgres to Starkeep

Before porting a Postgres schema, read the substitution table in
[postgres-substitutions.md](postgres-substitutions.md). In short: text primary
keys you generate, JSON as `text` or split into columns, `timestamp` via
`toISOString()`, no `OR` / `ON CONFLICT` / transactions / `UNIQUE` / joins, so
do that work client-side or with a label or metadata query.

## Recipes

- **Seed data**: write each seed row with a fixed primary key. Re-running the
  seed rewrites the same rows instead of duplicating them, and a concurrent
  second run does no harm.
- **"Pinned first, then newest"** with a boolean: two queries
  (`pinned: {is: true}` then `{is: false}`), each ordered by a timestamp, then
  concatenate. `searchNotes` in the example `api.ts` does exactly this.
- **A single-valued label** ("current status"): always write it through
  `POST /data/labels/values` with a one-element `values`.
- **Per-record app state** (such as a note on a photo): an app table whose
  primary key is `record_id`. Remove those rows yourself when the record is
  deleted, using the §9c feed
  ([§9c](../../ref/docs/authoring-an-app.md#9c-finding-out-what-was-deleted)).

## Related skills

- `starkeep-app-anatomy`: app shape and the manifest (`fileAccess`,
  `labelKeys`, `appSpecificSyncable`).
- `starkeep-run-local`: running the stack and sending a signed request to try
  these routes.
- `starkeep-cloud-and-sign-in`: cloud target and sign-in.
