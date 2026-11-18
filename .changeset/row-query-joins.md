---
"@starkeep/admin-manifest": minor
"@starkeep/storage-adapter": minor
"@starkeep/shared-space-api": minor
"@starkeep/storage-sqlite": minor
"@starkeep/storage-aurora-dsql": minor
---

The app row query gains a `join` parameter, column operands (`{"eq":{"col":"<table>.<column>"}}`), `exists` and `not_exists` subqueries, `in` and `not_in` with a subquery, an explicit `eq` and a literal `not_in`. Joined columns come back under qualified keys such as `"tasks.title"`, and a query with `join` must name its columns in `select`. The manifest validator refuses the column names `exists` and `not_exists`, two tables with one name, and two columns with one name in one table. `parseQuery` takes an optional `{ tables }` argument that enables the multi-table forms; without it, they are refused.
