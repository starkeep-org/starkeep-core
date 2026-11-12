# Postgres to Starkeep substitutions

For an agent porting a Postgres schema onto Starkeep's app tables
(`infraRequirements.appSpecificSyncable`). Read it with
[SKILL.md](SKILL.md), which states each limit and where it comes from.

Sources, shortened in the table below:

- §6 / §6a / §9a / §9b / §9c:
  [`docs/authoring-an-app.md`](../../ref/docs/authoring-an-app.md#6-app-specific-syncable-data)
  sections
  [6](../../ref/docs/authoring-an-app.md#6-app-specific-syncable-data),
  [6a](../../ref/docs/authoring-an-app.md#6a-querying-your-apps-tables),
  [9a](../../ref/docs/authoring-an-app.md#9a-querying-metadata-and-labels),
  [9b](../../ref/docs/authoring-an-app.md#9b-querying-records),
  [9c](../../ref/docs/authoring-an-app.md#9c-finding-out-what-was-deleted).
- `core-types.ts`:
  [`packages/protocol-primitives/src/types/core-types.ts`](https://github.com/myleshenderson/starkeep-core/blob/main/packages/protocol-primitives/src/types/core-types.ts)
  (`LOGICAL_COLUMN_TYPES`).
- `schema.ts`:
  [`packages/admin-manifest/src/schema.ts`](https://github.com/myleshenderson/starkeep-core/blob/main/packages/admin-manifest/src/schema.ts)
  (`syncableTableColumnSchema`, `syncableTableIndexSchema`).
- `parse.ts`:
  [`packages/shared-space-api/src/query/parse.ts`](https://github.com/myleshenderson/starkeep-core/blob/main/packages/shared-space-api/src/query/parse.ts).
- `factory.ts`:
  [`packages/shared-space-api/src/app-syncable/factory.ts`](https://github.com/myleshenderson/starkeep-core/blob/main/packages/shared-space-api/src/app-syncable/factory.ts)
  (`insertRow`); `apply.ts`:
  [`packages/storage-sqlite/src/app-syncable/apply.ts`](https://github.com/myleshenderson/starkeep-core/blob/main/packages/storage-sqlite/src/app-syncable/apply.ts)
  (`applyInsert`).

| Postgres                                  | Starkeep                                                                                                                                                                                         | Source                                   |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| `SERIAL`, `uuid` primary key              | A `text` primary key that your app generates. Prefer a key derived from what the row is, so a repeated write lands on the same row.                                                              | `core-types.ts`; `schema.ts`             |
| `jsonb`, `json`                           | `text` holding JSON. The grammar sees it as a string (equality, `prefix`, `like`), never as fields: split any field you filter or sort on into its own column.                                   | `core-types.ts`; §6a                     |
| `timestamptz`                             | `timestamp`, written with `toISOString()`. Any other spelling is rejected.                                                                                                                       | §6; `schema.ts`                          |
| `boolean`                                 | `boolean`, not `integer`. It cannot be ordered: filter with `is`, equality or `ne`.                                                                                                              | §6                                       |
| `numeric`, `decimal`, money               | `real`, or `bigint` holding the smallest unit (cents) when you need exact arithmetic.                                                                                                            | `core-types.ts`                          |
| arrays, enums, uuid type                  | No such column type. Use `text` (one value per row in a child table, or JSON text), and validate enums in your app.                                                                              | `core-types.ts`                          |
| `updated_at`, `deleted_at` columns        | Reserved by the sync runtime. Rename yours (for example `updated_on`).                                                                                                                           | `schema.ts` (`RESERVED_SYNC_COLUMNS`)    |
| `WHERE a OR b`                            | Two queries, merged and de-duplicated client-side. `in` covers "one column, any of these values" (up to 500).                                                                                    | §6a; `parse.ts` (`MAX_IN_LIST`)          |
| `INSERT … ON CONFLICT DO NOTHING`         | Not available: every insert replaces the columns it sends on a matching primary key. Key rows deterministically so the replacement is harmless.                                                  | `factory.ts`; `apply.ts`                 |
| `INSERT … ON CONFLICT DO UPDATE`          | Plain `POST /app-data/db/<table>` with `{row}`.                                                                                                                                                  | `factory.ts`; `apply.ts`                 |
| multi-row `INSERT`, `COPY`                | One `POST` per row.                                                                                                                                                                              | `apps/local-data-server/server.ts`       |
| `BEGIN … COMMIT`                          | None. Each call writes one row; make each write idempotent so a partial run can be retried.                                                                                                      | `factory.ts`                             |
| `UPDATE … WHERE <range>` / bulk `DELETE`  | `PATCH`/`DELETE` address one row by its full primary key. Query the keys first, then write each.                                                                                                 | `requireKeyedWhere` (see SKILL.md)       |
| `UNIQUE`, `UNIQUE` index                  | Primary key only. Indexes are an ordered column list with no unique or partial form.                                                                                                             | `schema.ts` (`syncableTableIndexSchema`) |
| `CREATE INDEX`                            | `indexes: [{"columns": [...]}]` on the table in the manifest. Declare one per filter you issue; without it the filter is a full scan.                                                            | §6; `schema.ts`                          |
| `LIMIT` / `OFFSET`                        | `limit` (default 30, max 500) plus the opaque `page_token`. There is no offset.                                                                                                                  | §6a; `parse.ts`                          |
| `GROUP BY`, `count(*)`, `sum`             | `aggregate` with `select` as the grouping list. `sum`/`avg` of nothing is `null`; empty groups are omitted.                                                                                      | §6a                                      |
| SQL functions, CTEs, joins, subqueries    | Page through the rows and compute client-side. For questions about shared records, query metadata or labels (`/data/metadata/<category>`, `/data/labels`) and hydrate records by id (`in` list). | §9a; §9b                                 |
| foreign key to a shared record, `CASCADE` | A `record_id` column with no constraint. Delete your rows yourself from the deleted-records feed.                                                                                                | §9c                                      |
