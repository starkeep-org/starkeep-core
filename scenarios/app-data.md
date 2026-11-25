# App data

This file specifies an app's own data on Starkeep: the tables an app declares, the rows it writes and queries, its private files, analysis reads over a snapshot of its rows, its background jobs, and the credential vault that keeps third-party secrets for those jobs. An app developer writes and reads rows, files, jobs, and secrets through the data servers' app-facing routes and the app client. A member turns a job on at the platform's consent page and manages it on the connections page. A cloud operator's AWS access meets the vault only to delete secrets. The examples use an app called "planner" that declares a `projects` table and a `tasks` table with a `project_id` column.

Related files:

- [app-lifecycle.md](app-lifecycle.md): declaring tables and jobs in the manifest, the install consent dialog's jobs panel, tables added at update, and app data kept across uninstall and reinstall, including Delete data and `cli:delete-app-data`.
- [users-and-access.md](users-and-access.md): which member's rows an app session reaches, outside-client tokens and their modes, and the consent and connections pages' host.
- [shared-data.md](shared-data.md): shared records, labels, and how the records, metadata, and label routes apply the query grammar.
- [sync.md](sync.md): how an app's rows reach the member's other devices and the cloud.
- [uploads-and-file-bytes.md](uploads-and-file-bytes.md): uploading an app's private files and moving their bytes.
- [cloud-runtime.md](cloud-runtime.md): the job dispatcher as a cloud operator sees it.
- [app-development.md](app-development.md): the app client and SDK as a whole, and the example app.

## Tables and rows

An app declares its tables under `infraRequirements.appSpecificSyncable` in its manifest. The manifest rules belong to [app-lifecycle.md](app-lifecycle.md) (APP-LIFE-176). Each table holds the app's rows for each member, apart from every other app.

### Declared tables

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DATA-001] An app reads and writes rows only in the tables its manifest declares
  Given an app developer's app "planner" declares the tables "projects" and "tasks"
  When the app writes a row to "budgets"
  Then the write fails with a bad-request error that reads "App \"planner\" did not declare app-syncable table \"budgets\""
  And a read of "budgets" fails with the same error
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DATA-002] An app that declares no tables gets a not-found answer that names the missing declaration
  Given an app developer's app declares no app tables
  When the app reads or writes any row
  Then the app receives a not-found answer that reads "App did not declare appSpecificSyncable in its manifest"
  And the answer carries no "skipped" field, so the app can tell it from a missing row
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DATA-003] An app cannot reach the platform's own bookkeeping tables
  Given an app developer's app "planner" declares app tables and private files
  When the app reads or writes the table "_starkeep_sync_records"
  Then the request fails with a bad-request error that reads "Table \"_starkeep_sync_records\" is reserved by the sync runtime and not writable by apps"
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DATA-004] Two apps that declare a table with the same name keep separate rows
  Given an app developer's two apps each declare a table called "notes"
  When the first app writes a note
  Then the second app's "notes" table does not hold the note
  And the first app reads its note back
```

- **Notes:** Each app's tables live under the app's own name: `app_<appId>.<table>` in the cloud, `<appId>_syncable_<table>` on a computer.

```gherkin
@local
@intent:confirmed
Scenario: [APP-DATA-005] Another app, even Drive, cannot read an app's own rows
  Given an app developer's app keeps notes in its own table on a member's computer
  When the app developer signs a request for the app's notes table with Drive's credentials
  Then the request fails
  And Drive receives none of the app's notes, although Drive reads every shared type
```

- **Notes:** The shared-record half of this behavior is SHARED-020 in [shared-data.md](shared-data.md).

### Writing rows

Three routes write to `/app-data/db/<table>`. `POST` upserts a row, `PATCH` changes named columns of one row, and `DELETE` records a deletion. Each answer says what the write did.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DATA-006] An app creates a row and reads it back with its write stamp
  Given an app developer's app "planner" declares a "tasks" table keyed by "id"
  When the app posts {"row": {"id": "t1", "title": "Buy paint"}} to "tasks"
  Then the app receives {"ok": true, "changes": 1}
  And a read of "tasks" that selects "id,title,updated_at" returns the row with an "updated_at" stamp the platform wrote
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DATA-007] Posting a row on an existing key overwrites the named columns and brings back a deleted row
  Given an app developer's app deleted the task "t1"
  When the app posts a row with the id "t1" without ifAbsent
  Then the app receives {"ok": true, "changes": 1}
  And the task "t1" appears in reads again with the posted values
```

```gherkin
@local @cloud
@intent:confirmed
Scenario Outline: [APP-DATA-008] A seed write with ifAbsent lands only when no live or deleted row holds the key
  Given an app developer's app seeds a starter task with a fixed id
  And <state>
  When the app posts the starter task with "ifAbsent": true
  Then the app receives <answer>
  And <result>

  Examples:
    | state                                    | answer                                                 | result                                       |
    | no row has ever held the id              | {"ok": true, "changes": 1}                             | the starter task appears in reads            |
    | the member edited the starter task       | {"ok": true, "changes": 0, "skipped": "live"}          | the member's edit stays                      |
    | the member deleted the starter task      | {"ok": true, "changes": 0, "skipped": "deleted"}       | the starter task stays out of every read     |
```

- **Notes:** The guarantee holds on one surface. A surface that has not yet received a deletion from another surface still writes the seed, and the later write wins at sync. A table with a composite key compares the whole key.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DATA-009] A patch writes only the named columns and leaves the rest
  Given an app developer's app holds the task "t1" with a title and a due date
  When the app sends PATCH {"where": {"id": "t1"}, "patch": {"title": "Buy blue paint"}}
  Then the app receives {"changes": 1}
  And a read of "t1" shows the new title and the old due date
```

```gherkin
@local @cloud
@intent:confirmed
Scenario Outline: [APP-DATA-010] A patch of a missing or deleted row gets a not-found answer marked missing
  Given an app developer's app <state>
  When the app sends a patch for the task "t9"
  Then the app receives a not-found answer {"error": "No live row holds that key", "changes": 0, "skipped": "missing"}
  And no task "t9" appears in reads

  Examples:
    | state                                    |
    | never wrote the task "t9"                |
    | deleted the task "t9"                    |
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DATA-011] A deleted row leaves every read, and a retried delete still succeeds
  Given an app developer's app holds the task "t1"
  When the app sends DELETE {"where": {"id": "t1"}} twice
  Then the first delete answers {"changes": 1}
  And the second delete answers {"changes": 0, "skipped": "deleted"} with success
  And no read returns the task "t1"
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DATA-012] Deleting a key no row ever held gets a not-found answer marked missing
  Given an app developer's app never wrote the task "t9"
  When the app sends DELETE {"where": {"id": "t9"}}
  Then the app receives a not-found answer {"error": "No live row holds that key", "changes": 0, "skipped": "missing"}
```

- **Notes:** An MCP tool or an API built on the row routes can pass this 404 through as "not found" without a read beforehand.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DATA-013] A guarded patch or delete whose stamp is out of date gets a conflict and changes nothing
  Given an app developer's app read the task "t1" with its "updated_at" stamp
  And another tab of the app changed the task since that read
  When the app sends a patch or a delete of "t1" with "ifUpdatedAt" set to the stamp it read
  Then the app receives a conflict {"error": "The row changed since the stamp the write named", "changes": 0, "skipped": "stale"}
  And the task keeps the other tab's change
```

- **Notes:** The guard covers clients of one data server. Across surfaces, the newer write still wins the whole row.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DATA-014] A write that loses to a newer stamp gets a conflict marked superseded
  Given an app developer's app holds the task "t1" with a stamp that synced from a surface whose clock runs ahead
  When the app posts, patches, or deletes "t1" before its own clock passes that stamp
  Then the app receives a conflict {"error": "A newer write to the row won, so this write changed nothing", "changes": 0, "skipped": "superseded"}
  And the task keeps the newer values
```

```gherkin
@local @cloud
@intent:confirmed
Scenario Outline: [APP-DATA-015] A write that names the other route's condition is refused and writes nothing
  Given an app developer's app holds the task "t1"
  When the app sends <method> to "tasks" with "<condition>" in the body
  Then the write fails with a bad-request error that reads "<message>"
  And the task "t1" is unchanged

  Examples:
    | method | condition   | message                                                        |
    | POST   | ifUpdatedAt | POST does not take ifUpdatedAt. It takes ifAbsent only.        |
    | PATCH  | ifAbsent    | PATCH does not take ifAbsent. It takes ifUpdatedAt only.       |
    | DELETE | ifAbsent    | DELETE does not take ifAbsent. It takes ifUpdatedAt only.      |
```

- **Notes:** A misplaced condition sent as null is refused the same way, so a guard never silently goes missing.

```gherkin
@local @cloud
@intent:confirmed
Scenario Outline: [APP-DATA-016] A malformed ifAbsent or ifUpdatedAt is refused rather than ignored
  Given an app developer's app holds the task "t1"
  When the app sends <method> with <condition>
  Then the write fails with a bad-request error that reads "<message>"
  And the task "t1" is unchanged

  Examples:
    | method | condition                               | message                                                          |
    | POST   | "ifAbsent": "true"                      | ifAbsent must be a boolean                                       |
    | PATCH  | "ifUpdatedAt": "2026-11-23T10:00:00Z"   | ifUpdatedAt must be a row's updated_at, as a read returned it    |
```

```gherkin
@local @cloud
@intent:confirmed
Scenario Outline: [APP-DATA-017] A patch or delete that does not name the whole primary key is refused and changes nothing
  Given an app developer's app declares a "members" table keyed by "project_id" and "user"
  When the app sends <method> with a where that names <names>
  Then the write fails with a bad-request error that reads "<message>"
  And every row of "members" is unchanged

  Examples:
    | method | names             | message                                                                                                                                         |
    | PATCH  | no column         | app-syncable update for planner.members carries no "where" — a keyless update would match every row in the table and is refused                 |
    | DELETE | no column         | app-syncable delete for planner.members carries no "where" — a keyless delete would match every row in the table and is refused                 |
    | PATCH  | only "project_id" | app-syncable update for planner.members names only part of the primary key (missing user) — a partial key matches more rows than the one it came from and is refused |
    | DELETE | only "project_id" | app-syncable delete for planner.members names only part of the primary key (missing user) — a partial key matches more rows than the one it came from and is refused |
```

- **Notes:** "No column" means the body `{"where": {}, …}`. The text comes from `packages/storage-adapter/src/database/app-syncable-rows.ts`. A seed write with ifAbsent that lacks part of the key is refused too.

```gherkin
@local @cloud
@intent:confirmed
Scenario Outline: [APP-DATA-018] A write body without its row, where, or patch is refused
  Given an app developer's app declares a "tasks" table
  When the app sends <method> to "tasks" with the body <body>
  Then the write fails with a bad-request error that reads "<message>"

  Examples:
    | method | body                       | message                    |
    | POST   | {}                         | row is required            |
    | PATCH  | {"where": {"id": "t1"}}    | where and patch are required |
    | DELETE | {}                         | where is required          |
```

### Column types

Column types are `text`, `integer`, `bigint`, `real`, `blob`, `boolean`, and `timestamp`. The write path enforces each declared type.

```gherkin
@local @cloud
@intent:confirmed
Scenario Outline: [APP-DATA-019] A value that does not match its column's declared type is refused, and nothing is written
  Given an app developer's app declares the "tasks" column "<column>" as <type>
  When the app posts a task whose "<column>" is <value>
  Then the write fails with a bad-request error that reads "tasks: \"<column>\" is declared <type> and received <received>: <detail>"
  And no task is written

  Examples:
    | column   | type    | value  | received       | detail                         |
    | title    | text    | 42     | number 42      | expected a string              |
    | estimate | integer | 1.5    | number 1.5     | expected a whole number        |
    | weight   | real    | "1.5"  | string "1.5"   | expected a number              |
    | done     | boolean | 2      | number 2       | expected true, false, 0 or 1   |
    | done     | boolean | "yes"  | string "yes"   | expected true, false, 0 or 1   |
```

- **Notes:** The value descriptions come from `packages/shared-space-api/src/query/values.ts` (`describe`): an array reads "an array", an object "an object", and any other value its JSON type and spelling. A filter value that does not match its column is refused with the same message, without the table prefix.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DATA-020] A timestamp column accepts only canonical ISO-8601 in UTC at millisecond precision
  Given an app developer's app declares the "tasks" column "due" as timestamp
  When the app posts a task whose "due" is "2026-01-01T00:00:00Z"
  Then the write fails with a bad-request error that reads "tasks: \"due\" is declared timestamp and received string \"2026-01-01T00:00:00Z\": expected canonical ISO-8601 in UTC, e.g. 2026-09-09T00:00:00.000Z"
  And a task whose "due" is "2026-01-01T00:00:00.000Z", as JavaScript's toISOString() writes it, is accepted
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DATA-021] A boolean column takes true, false, 0, or 1 and always reads back as true or false
  Given an app developer's app declares the "tasks" column "done" as boolean
  When the app writes one task with "done" set to 1 and another with "done" set to false
  Then a read returns "done" as true and as false
  And a read of the same rows after they sync to the other surface returns the same values
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DATA-022] Numbers and timestamps read back in one form on both surfaces
  Given an app developer's app declares bigint, real, and timestamp columns
  When the app writes rows on a computer and in the cloud and reads them back on each
  Then a bigint, a real at full double precision, and a timestamp each read back with the same value and form on both surfaces
  And an average over an integer column comes back as one number type on both surfaces
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DATA-023] A write that names a column the table does not declare is refused
  Given an app developer's app declares a "tasks" table without a "colour" column
  When the app posts a task with a "colour" value
  Then the write fails with a bad-request error
  And no task is written
```

- **Notes:** The type check passes an undeclared key through, and the database refuses it, so the message is the database's own and differs between the two surfaces (`packages/shared-space-api/src/app-syncable/factory.ts`, `validateRow`).

## Querying rows

`GET /app-data/db/<table>` takes the query grammar that both data servers share: `where`, `select`, `join`, `order`, `limit`, `page_token`, and `aggregate`. The records, metadata, and label routes apply the same grammar, and [shared-data.md](shared-data.md) states how. The answer is `{rows, truncated, page_token}`, or `{groups, truncated}` for an aggregate.

### Filters

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DATA-024] An app filters, selects, orders, and limits rows in one request
  Given an app developer's app holds tasks in several projects
  When the app reads "tasks" with where {"project_id": "p1", "due": {"lte": "2026-12-01T00:00:00.000Z"}}, select "id,title,due", order [{"col": "due"}], and limit 50
  Then the app receives only project "p1"'s tasks due by that time, earliest first
  And each row holds only "id", "title", and "due"
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DATA-025] Equality with null finds the rows where the column is empty
  Given an app developer's app holds tasks with and without an assignee
  When the app reads "tasks" with where {"assignee": null}
  Then the app receives exactly the tasks that have no assignee
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DATA-026] A not-equal filter keeps the rows where the column is empty
  Given an app developer's app holds tasks assigned to "ana", to "ben", and to nobody
  When the app reads "tasks" with where {"assignee": {"ne": "ana"}}
  Then the app receives the tasks assigned to "ben" and the tasks assigned to nobody
```

- **Notes:** Bare SQL's `<>` drops the empty rows. The grammar keeps them on both surfaces, so `ne` is the exact complement of equality.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DATA-027] An is filter tests for null, true, or false
  Given an app developer's app declares the "tasks" column "done" as boolean
  When the app reads "tasks" with where {"done": {"is": true}}
  Then the app receives exactly the tasks whose "done" is true
  And where {"due": {"is": null}} returns exactly the tasks with no due date
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DATA-028] A not_in filter keeps the rows where the column is empty
  Given an app developer's app holds tasks with the status "open", "blocked", "done", and no status
  When the app reads "tasks" with where {"status": {"not_in": ["done"]}}
  Then the app receives the open tasks, the blocked tasks, and the tasks with no status
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DATA-029] Timestamp filters compare instants
  Given an app developer's app holds tasks whose "due" values fall on either side of noon UTC on one day
  When the app reads "tasks" with where {"due": {"gt": "2026-12-01T12:00:00.000Z"}}
  Then the app receives exactly the tasks due after that instant
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DATA-030] Deleted rows never appear in a query
  Given an app developer's app deleted the task "t1"
  When the app reads "tasks" with any filter, order, or aggregate
  Then no answer includes or counts the task "t1"
```

### Text matching

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DATA-031] A prefix filter matches a literal start, case-sensitively
  Given an app developer's app holds the tasks "Buy paint", "buy brushes", and "50% off sale"
  When the app reads "tasks" with where {"title": {"prefix": "Buy"}}
  Then the app receives "Buy paint" and not "buy brushes"
  And where {"title": {"prefix": "50%"}} returns only "50% off sale", because "%" in a prefix is a plain character
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DATA-032] A like filter matches wildcards anywhere, case-sensitively on both surfaces
  Given an app developer's app holds the tasks "Buy paint", "Repaint the door", and "PAINT samples"
  When the app reads "tasks" with where {"title": {"like": "%paint%"}}
  Then the app receives "Buy paint" and "Repaint the door" and not "PAINT samples"
  And the computer and the cloud return the same rows for the same pattern
```

- **Notes:** `%` matches any run of characters and `_` matches exactly one. A pattern that starts with `%` scans, as an equality filter on an unindexed column does.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DATA-033] A like pattern escapes a wildcard with a backslash
  Given an app developer's app holds the tasks "50% done" and "500 done"
  When the app reads "tasks" with a like pattern of "50\%%"
  Then the app receives "50% done" and not "500 done"
```

### Order, limit, and pages

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DATA-034] Rows come back in the order the app names, with empty values where the app says
  Given an app developer's app holds tasks with and without a due date
  When the app reads "tasks" with order [{"col": "due", "dir": "desc", "nulls": "first"}]
  Then the tasks with no due date come first on both the computer and the cloud
  And the rest follow latest first, with ties broken by the primary key
```

- **Notes:** `dir` defaults to `asc` and `nulls` to `last`. The two databases default the null position differently, so the grammar always states one.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DATA-035] The older flat order spelling still works and carries a deprecation notice
  Given an app developer's app still sends order "due.desc"
  When the app reads "tasks"
  Then the app receives the same rows as with order [{"col": "due", "dir": "desc"}]
  And the answer carries the header "Deprecation: @1794960000" and a "Link" header to the app authoring guide with rel="deprecation"
```

- **Notes:** The JSON spelling carries no such header. The data server logs one line per app per process for the flat spelling. The flat spelling cannot name a joined column.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DATA-036] A page holds 30 rows unless the app names a limit, and at most 500
  Given an app developer's app holds 600 tasks
  When the app reads "tasks" without a limit
  Then the app receives 30 tasks with "truncated" true
  And a read with limit 500 returns 500 tasks
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DATA-037] An app pages through a table with the page token and sees every row exactly once
  Given an app developer's app holds 75 tasks, some with no due date
  When the app reads "tasks" ordered by due date with limit 20 and follows each "page_token" until "truncated" is false
  Then the app receives every task exactly once, including the tasks with no due date
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DATA-038] A page token from a read under one order is refused under another
  Given an app developer's app holds a page token from a read ordered by due date
  When the app sends the token with order [{"col": "title"}]
  Then the read fails with a bad-request error that starts "page_token was cut under a different ordering"
  And the error names the order to re-request the first page under
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DATA-039] A page token the server did not issue is refused
  Given an app developer's app builds its own page token
  When the app sends the token to "tasks"
  Then the read fails with a bad-request error that reads "page_token is not a token this server issued"
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DATA-040] A page cut short by the 4 MB response budget is marked truncated
  Given an app developer's app holds 500 tasks with long descriptions that together exceed 4 MB
  When the app reads "tasks" with limit 500
  Then the app receives fewer than 500 tasks with "truncated" true and a "page_token"
  And following the token returns the remaining tasks
```

- **Notes:** A short page is never a complete result unless `truncated` is false.

### Refused queries

```gherkin
@local @cloud
@intent:confirmed
Scenario Outline: [APP-DATA-041] A query the grammar cannot read is refused with a message that names the fix
  Given an app developer's app declares a "tasks" table
  When the app reads "tasks" with <query>
  Then the read fails with a bad-request error that reads <message>

  Examples:
    | query                                     | message                                                                                                                                                     |
    | the parameter done=false                  | "\"done\" is not a query parameter. Filters go under where as JSON, e.g. where={\"done\":\"false\"}. Parameters: where, select, aggregate, order, limit, page_token, include, join" |
    | where {done: false}                       | a message that starts "where must be JSON:"                                                                                                                 |
    | where {"colour": "red"}                   | "\"colour\" is not a column of \"tasks\""                                                                                                                    |
    | where {"title": {"matches": "x"}}         | "\"matches\" is not an operator; supported operators are eq, ne, lt, lte, gt, gte, in, not_in, is, prefix, like"                                            |
    | where {"title": {}}                       | "where[\"title\"] is an empty object and asks nothing"                                                                                                      |
    | where {"title": {"in": "open"}}           | "in takes a JSON array or a subquery; \"title\" received something else"                                                                                    |
    | an in list of 501 values                  | "in takes at most 500 values; \"status\" received 501"                                                                                                      |
    | where {"estimate": {"prefix": "1"}}       | "prefix applies to a text or timestamp column; \"estimate\" is integer"                                                                                     |
    | where {"estimate": {"like": "1%"}}        | "like applies to a text or timestamp column; \"estimate\" is integer"                                                                                       |
    | where {"title": {"like": ""}}             | "like takes a non-empty pattern"                                                                                                                            |
    | a like pattern of 201 characters          | "like pattern is 201 characters; the maximum is 200"                                                                                                        |
    | a like pattern holding "\d"               | "\d is not a like escape: only \%, \_ and \\ are meaningful. like matches wildcards, not character classes: % is any run of characters and _ is exactly one" |
    | a like pattern that ends in a lone "\"    | "like pattern ends in a lone \; write \\ for a literal backslash"                                                                                       |
    | where {"title": {"is": true}}             | "is true/false applies to a boolean column; \"title\" is text"                                                                                              |
    | order [{"col": "due", "dir": "down"}]     | "an order term's dir must be \"asc\" or \"desc\""                                                                                                           |
    | order "due.tasks"                         | "\"tasks\" is not an order modifier; use asc, desc, nullsfirst or nullslast. A column of a joined table needs the JSON form of order, such as [{\"col\":\"due.tasks\"}]" |
    | limit 501                                 | "limit must be at most 500"                                                                                                                                 |
    | limit 0                                   | "limit must be a whole number of at least 1"                                                                                                                |
```

- **Notes:** The in-list row assumes the filter is on "status". A refused query never falls back to ignoring the part it could not read.

```gherkin
@local @cloud
@intent:confirmed
Scenario Outline: [APP-DATA-042] A filter whose answer is known in advance is refused rather than answered
  Given an app developer's app declares a "tasks" table whose "id" is NOT NULL
  When the app reads "tasks" with where <filter>
  Then the read fails with a bad-request error that reads <message>

  Examples:
    | filter                                   | message                                                                                                         |
    | {"status": {"in": []}}                   | "in with an empty list matches nothing; omit the predicate"                                                    |
    | {"status": {"not_in": []}}               | "not_in with an empty list matches everything; omit the predicate"                                             |
    | {"due": {"lt": null}}                    | "lt against null is never true; use {\"is\": null} to test for absence"                                        |
    | {"id": {"is": null}}                     | "\"id\" is NOT NULL, so is null matches nothing"                                                              |
    | {"id": null}                             | "\"id\" is NOT NULL, so a null predicate matches nothing"                                                     |
    | {"status": {"not_in": ["done", null]}}   | "not_in cannot hold null; not_in already keeps the rows where \"status\" is null, and {\"ne\": null} beside it drops them" |
```

```gherkin
@local @cloud
@intent:confirmed
Scenario Outline: [APP-DATA-043] Ordering comparisons refuse boolean and blob columns
  Given an app developer's app declares "done" as boolean and "cover" as blob
  When the app reads "tasks" with <query>
  Then the read fails with a bad-request error that reads <message>

  Examples:
    | query                               | message                                               |
    | where {"done": {"lt": true}}        | "\"done\" is a boolean and has no ordering"           |
    | order [{"col": "done"}]             | "\"done\" is a boolean and has no ordering"           |
    | where {"cover": {"gt": "x"}}        | "\"cover\" is a blob and has no ordering"             |
    | where {"cover": "x"}                | "\"cover\" is a blob and cannot appear in a predicate" |
```

- **Notes:** A flag answers every question with `is`, equality, and `ne`. A blob may still appear in `select`.

```gherkin
@local @cloud
@intent:confirmed
Scenario Outline: [APP-DATA-044] An app names the platform's stamp columns only where the grammar allows them
  Given an app developer's app declares a "tasks" table
  When the app reads "tasks" with <query>
  Then <outcome>

  Examples:
    | query                                           | outcome                                                                                                                                     |
    | select "id,updated_at" and order by updated_at  | the app receives each task's id and stamp in stamp order                                                                                   |
    | where {"updated_at": {"gt": "x"}}               | the read fails with a bad-request error that reads "\"updated_at\" is a sync-internal column and may appear in select and order only"       |
    | where {"deleted_at": null}                      | the read fails with a bad-request error that reads "\"deleted_at\" is owned by the server, which always excludes soft-deleted rows; it cannot appear in where" |
    | select "id,deleted_at"                          | the read fails with a bad-request error that reads "\"deleted_at\" is owned by the server and cannot be projected"                         |
```

### Aggregates

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DATA-045] An app groups rows by the select list and gets one result per group
  Given an app developer's app holds open tasks in projects "p1" and "p2"
  When the app reads "tasks" with select "project_id" and aggregate {"open": {"fn": "count"}, "next_due": {"fn": "min", "col": "due"}}
  Then the app receives {"groups": [...], "truncated": false} with one group per project
  And each group holds its "project_id", its "open" count, and its earliest "next_due"
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DATA-046] An aggregate with no select list answers one total
  Given an app developer's app holds 12 tasks
  When the app reads "tasks" with aggregate {"n": {"fn": "count"}} and no select
  Then the app receives one group whose "n" is 12
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DATA-047] Counting rows, values, and distinct values gives three different numbers
  Given an app developer's app holds five tasks, three of them assigned, to two different people
  When the app reads "tasks" with aggregate {"rows": {"fn": "count"}, "assigned": {"fn": "count", "col": "assignee"}, "people": {"fn": "count", "distinct": "assignee"}}
  Then the app receives "rows" 5, "assigned" 3, and "people" 2
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DATA-048] A sum or average over no rows is null, not zero
  Given an app developer's app holds no tasks in project "p9"
  When the app reads "tasks" with where {"project_id": "p9"} and aggregate {"hours": {"fn": "sum", "col": "estimate"}, "mean": {"fn": "avg", "col": "estimate"}}
  Then the app receives one group whose "hours" and "mean" are both null
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DATA-049] A grouped aggregate leaves out groups with no rows
  Given an app developer's app holds open tasks in project "p1" and none in project "p2"
  When the app reads open tasks grouped by "project_id" with a count
  Then the app receives a group for "p1" and no group for "p2"
```

- **Notes:** An app that shows every project fills the missing groups from its own list of projects.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DATA-050] Minimum and maximum skip empty values
  Given an app developer's app holds tasks with due dates and tasks with none
  When the app reads "tasks" with aggregate {"first": {"fn": "min", "col": "due"}, "last": {"fn": "max", "col": "due"}}
  Then "first" and "last" are the earliest and latest due dates that exist, grouped or not
```

```gherkin
@local @cloud
@intent:confirmed
Scenario Outline: [APP-DATA-051] An aggregate the grammar cannot answer is refused
  Given an app developer's app declares "title" as text, "estimate" as integer, and "done" as boolean
  When the app reads "tasks" with <query>
  Then the read fails with a bad-request error that reads <message>

  Examples:
    | query                                                          | message                                                                                                                          |
    | aggregate {"n": {"fn": "count"}} and a page_token              | "page_token addresses a row and an aggregate result holds none; aggregate queries are bounded by limit and report truncated"      |
    | aggregate {"title": {"fn": "count"}}                           | "aggregate output \"title\" collides with a column of \"tasks\""                                                                 |
    | aggregate {"s": {"fn": "sum", "distinct": "estimate"}}         | "distinct applies to count only, not to sum"                                                                                     |
    | aggregate {"s": {"fn": "sum", "col": "title"}}                 | "sum needs a numeric column; \"title\" is text"                                                                                  |
    | aggregate {"m": {"fn": "max", "col": "done"}}                  | "max needs an orderable column; \"done\" is boolean"                                                                             |
    | select "project_id", aggregate {"n": {"fn": "count"}}, order [{"col": "title"}] | "order may name a grouping column or an aggregate output; \"title\" is neither"                                 |
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DATA-052] An app orders groups by a grouping column or an aggregate result
  Given an app developer's app holds tasks in several projects
  When the app reads "tasks" grouped by "project_id" with aggregate {"n": {"fn": "count"}} and order [{"col": "n", "dir": "desc"}]
  Then the app receives the groups with the most tasks first
```

### Joins and subqueries

A query can read the app's other tables in the same request. A bare name means a column of the table in the path, and `<table>.<column>` means a column of a joined table. Inside `on` and inside a subquery, every name carries its table.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DATA-053] An inner join returns one row per parent and matching child, with joined columns under qualified names
  Given an app developer's app holds project "p1" with two tasks
  When the app reads "projects" with join [{"table": "tasks", "kind": "inner", "on": {"tasks.project_id": {"eq": {"col": "projects.id"}}}}] and select "id,name,tasks.title"
  Then the app receives two rows for "p1"
  And each row holds "id" and "name" under their bare names and the task's title under "tasks.title"
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DATA-054] A left join keeps a parent with no match and nulls the joined columns
  Given an app developer's app holds project "p2" with no tasks
  When the app reads "projects" left-joined to "tasks" with select "id,tasks.id,tasks.title"
  Then the app receives one row for "p2" whose "tasks.id" and "tasks.title" are null
```

- **Notes:** Test the joined table's `id` to tell "no match" from a matched row with empty values.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DATA-055] A filter inside on keeps an unmatched parent, and the same filter in where drops it
  Given an app developer's app holds project "p1" whose tasks are all done
  When the app left-joins "tasks" to "projects" with "tasks.done": false inside on
  Then the app receives "p1" once with null task columns
  And the same filter in where returns no row for "p1"
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DATA-056] Deleted rows of a joined table never match
  Given an app developer's app deleted the only task of project "p3"
  When the app reads "projects" left-joined to "tasks"
  Then the app receives "p3" once with null task columns
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DATA-057] A join must name its columns in select
  Given an app developer's app declares "projects" and "tasks"
  When the app reads "projects" with a join and no select
  Then the read fails with a bad-request error that reads "a query with join must name its columns in select"
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DATA-058] An app joins a table to itself through an alias
  Given an app developer's app keeps subtasks as "tasks" rows with a "parent_id"
  When the app reads "tasks" with join [{"table": "tasks", "as": "parent", "kind": "left", "on": {"parent.id": {"eq": {"col": "tasks.parent_id"}}}}] and select "id,title,parent.title"
  Then each row holds its own title and its parent's title under "parent.title"
```

```gherkin
@local @cloud
@intent:confirmed
Scenario Outline: [APP-DATA-059] A join or column operand the grammar cannot place is refused with a message that names the fix
  Given an app developer's app declares "projects" and "tasks"
  When the app reads "projects" with <join>
  Then the read fails with a bad-request error that reads <message>

  Examples:
    | join                                                              | message                                                                                                                                                          |
    | a second join of "projects" without an as                         | "\"projects\" is already in scope here; give the second use an \"as\", such as {\"table\":\"projects\",\"as\":\"other_projects\"}"                                |
    | a join of "tasks" with "as": "projects"                           | "\"as\" must not be a table name; \"projects\" names a table of this app"                                                                                       |
    | a join of "tasks" whose on holds only {"tasks.done": false}       | "the join of \"tasks\" must compare one of its columns with a column of an earlier table, such as {\"tasks.<column>\": {\"eq\": {\"col\": \"projects.id\"}}}"      |
    | a join of "tasks" whose on names "project_id" without its table   | "\"project_id\" needs its table: inside on and inside a subquery, name every column as <table>.<column>, such as \"projects.project_id\""                       |
    | a join of "tasks" with "kind": "outer"                            | "a join's kind must be \"inner\" or \"left\""                                                                                                                    |
    | select "id,members.user" with no join of "members"                | "\"members\" is not a table in scope here; in scope: projects"                                                                                                   |
    | a join of "tasks" and where {"tasks.title": {"eq": {"col": "projects.budget"}}}, where budget is integer | "\"tasks.title\" is text and \"projects.budget\" is integer; a column operand must share its column's type"                                       |
```

- **Notes:** An `on` that names a table joined after it is refused too. Two numeric types count as one type for a column operand. The grammar has no cross join.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DATA-060] A column operand compares two columns of one type
  Given an app developer's app holds tasks with a "due" date and projects with a "deadline"
  When the app reads "projects" joined to "tasks" with where {"tasks.due": {"gt": {"col": "projects.deadline"}}}
  Then the app receives only the tasks due after their project's deadline
  And a "ne" comparison between two columns returns exactly the rows an "eq" comparison leaves out, including rows where either column is empty
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DATA-061] An exists or not_exists filter tests related rows without returning them
  Given an app developer's app holds projects with and without open tasks
  When the app reads "projects" with where {"exists": [{"table": "tasks", "where": {"tasks.project_id": {"eq": {"col": "projects.id"}}, "tasks.done": false}}]}
  Then the app receives each project with an open task once, with no task columns
  And not_exists with the same subquery returns exactly the other projects
```

- **Notes:** Every subquery in the list must hold. A subquery may hold further `exists` entries, so a filter can reach a grandchild.

```gherkin
@local @cloud
@intent:confirmed
Scenario Outline: [APP-DATA-062] A subquery the grammar cannot place is refused
  Given an app developer's app declares "projects" and "tasks"
  When the app reads "projects" with <filter>
  Then the read fails with a bad-request error that reads <message>

  Examples:
    | filter                                                       | message                                                                                                                                                                       |
    | an exists subquery of "tasks" whose where names only "tasks.done" | "each exists subquery must compare a column of \"tasks\" with a column of an enclosing table, such as {\"tasks.<column>\": {\"eq\": {\"col\": \"projects.id\"}}}; otherwise it tests the whole table, not each row" |
    | exists subqueries nested five levels deep                    | "subqueries nest at most 4 levels deep"                                                                                                                                       |
    | {"exists": []}                                               | "exists takes a non-empty JSON array of subqueries"                                                                                                                           |
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DATA-063] An in or not_in filter takes a subquery that selects one column of the same type
  Given an app developer's app holds projects, some with open tasks
  When the app reads "projects" with where {"id": {"in": {"table": "tasks", "select": "tasks.project_id", "where": {"tasks.done": false}}}}
  Then the app receives each project with an open task once
  And not_in with the same subquery, over a NOT NULL column, returns exactly the other projects
```

```gherkin
@local @cloud
@intent:confirmed
Scenario Outline: [APP-DATA-064] An in or not_in subquery the grammar cannot answer faithfully is refused
  Given an app developer's app declares "tasks.project_id" as a text column that may be empty
  When the app reads "projects" with <filter>
  Then the read fails with a bad-request error that reads <message>

  Examples:
    | filter                                                                       | message                                                                                                                                                       |
    | {"id": {"not_in": {"table": "tasks", "select": "tasks.project_id"}}}         | "a not_in subquery must select a NOT NULL column, because one null makes NOT IN match nothing; \"tasks.project_id\" may be null, so use not_exists instead" |
    | {"id": {"in": {"table": "tasks", "select": "tasks.estimate"}}} where estimate is integer | "\"id\" is text and the subquery selects \"tasks.estimate\", which is integer; the two must share a type"                                          |
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DATA-065] With a join, the limit counts joined rows and the page token walks them exactly once
  Given an app developer's app holds three projects with four tasks each
  When the app reads "projects" joined to "tasks", ordered by project and task, with limit 5, and follows each page token
  Then each page holds at most five joined rows
  And the app receives each of the twelve project-and-task pairs exactly once
```

- **Notes:** To read "the latest project with all its tasks", order by the project's columns first and stop when the project id changes. Two to-many joins from one parent multiply their rows, so an app issues one query per to-many table.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DATA-066] An app aggregates over joined columns
  Given an app developer's app holds projects with and without tasks
  When the app reads "projects" left-joined to "tasks" with select "id" and aggregate {"task_count": {"fn": "count", "col": "tasks.id"}}
  Then each project's group counts its tasks
  And a project with no task counts 0
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DATA-067] A join reaches only the app's own declared tables
  Given an app developer's app "planner" declares "projects" and "tasks"
  When the app joins "projects" to "budgets"
  Then the read fails with a bad-request error that reads "App \"planner\" did not declare app-syncable table \"budgets\""
  And a join to "_starkeep_sync_records" is refused as a table reserved by the sync runtime
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DATA-068] A join never pairs one member's rows with another member's
  Given an app developer's app holds projects and tasks with the same ids for two members
  When the app reads one member's projects joined to tasks, with exists, in, and aggregate forms
  Then every answer holds and counts only that member's rows
```

- **Notes:** Per-member isolation of plain reads and writes is ACCESS-106 and ACCESS-107 in [users-and-access.md](users-and-access.md).

## App-private files

An app that declares `files: true` keeps private files under `apps/<appId>/<userId>/syncable/`, each named by a sub-key the app chooses, such as `exports/notes-1.json`. Uploading a file and moving its bytes belong to [uploads-and-file-bytes.md](uploads-and-file-bytes.md).

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DATA-069] An app lists its own files under a prefix in sub-key order, with each file's facts
  Given an app developer's app stored "exports/b.json", "exports/a.json", and "drafts/c.json"
  When the app asks for GET /app-data/files?prefix=exports/
  Then the app receives "exports/a.json" and then "exports/b.json"
  And each file carries "sub_key", "size_bytes", "mime_type", "original_filename", and "created_at"
```

- **Notes:** A listing without a prefix lists every file, and a fully qualified prefix lists the same files as its sub-key form. The answer is `{files, truncated, page_token}`.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DATA-070] An app pages through its file listing with a limit and a page token
  Given an app developer's app stored five files under "exports/"
  When the app lists "exports/" with limit 2 and follows each "page_token" until "truncated" is false
  Then the app receives each of the five files exactly once, in sub-key order
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DATA-071] A deleted file leaves the listing
  Given an app developer's app stored "exports/a.json" and "exports/b.json"
  When the app deletes "exports/a.json"
  Then the app's next listing of "exports/" holds only "exports/b.json"
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DATA-072] A listing prefix that would leave the app's own files is refused
  Given an app developer's app stores private files
  When the app lists files with the prefix "../other" or "/abs"
  Then the listing fails with a bad-request error
  And the app receives no other app's or member's file
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DATA-073] An app that did not opt in to files is refused on every file route
  Given an app developer's app "planner" declares tables with "files": false
  When the app lists, reads, or deletes a private file
  Then the request fails with a bad-request error that reads "App \"planner\" did not opt in to syncable files"
```

```gherkin
@local
@intent:confirmed
Scenario: [APP-DATA-074] One app's files are invisible to another app
  Given an app developer's two apps both store private files with the sub-key "exports/a.json"
  When the second app lists, reads, or deletes "exports/a.json"
  Then the second app reaches only its own file
  And the first app's file is unchanged
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DATA-075] A batch of file URLs leaves out sub-keys that hold no file
  Given an app developer's app stored "exports/a.json" and never stored "exports/z.json"
  When the app posts {"subKeys": ["exports/a.json", "exports/z.json"]} to /app-data/file-urls
  Then the app receives a URL for "exports/a.json"
  And the answer holds nothing for "exports/z.json"
```

```gherkin
@local @cloud
@intent:confirmed
Scenario Outline: [APP-DATA-156] A malformed batch of file URLs is refused
  Given an app developer's app stores private files
  When the app posts <body> to /app-data/file-urls
  Then the request fails with a bad-request error that reads "<message>"

  Examples:
    | body                           | message                                           |
    | {"subKeys": []}                | subKeys must be a non-empty array of strings      |
    | {"subKeys": "exports/a.json"}  | subKeys must be a non-empty array of strings      |
    | 201 sub-keys                   | subKeys must contain at most 200 entries          |
```

## Rows when a member trashes or restores a record

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DATA-076] An app's own rows about a record stay when the member trashes and restores it
  Given an app developer's app keeps a note row that names one of the member's files
  And the member deleted the file and later restored it from the Trash
  When the app reads its notes table
  Then the app receives the note row unchanged, as it did before the delete
```

- **Notes:** The platform neither deletes nor restores any of an app's own rows when a record goes to the Trash or comes back. An app that wants to hide its rows for a deleted record reconciles against the deletions feed in [shared-data.md](shared-data.md). The member's view of this behavior is SHARED-123.

## Analysis reads over a snapshot

`createSnapshotSql` from `@starkeep/app-client/snapshot` loads the app's own live rows through the row API into an in-memory SQLite in the app's server, caches the copy per member, and runs the app's read-only SQL against it.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DATA-077] An app runs read-only SQL over a copy of its own live rows, and the result says when the copy loaded
  Given an app developer's app keeps workout sets in a "sets" table
  When the app's server queries the snapshot with "SELECT strftime('%Y-%W', done_at) AS week, sum(reps * weight) AS volume FROM sets GROUP BY week"
  Then the app receives one row per week with its volume
  And the result carries "loadedAt", the time the copy's load started
```

- **Notes:** The copy holds only the member's live rows, without deleted rows or the platform's stamp columns. Joins, date functions, and window functions all work, because the copy is ordinary SQLite on every surface.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DATA-078] A copy answers until it is older than maxAge, and zero reloads it on every query
  Given an app developer's app queries its snapshot with maxAge set to five minutes
  When the app writes a new set and queries again within the five minutes
  Then the app receives the earlier answer without the new set, with the same "loadedAt"
  And a query after the five minutes, or any query with maxAge 0, includes the new set
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DATA-079] A Refresh floor reloads a copy loaded before it
  Given an app developer's app shows a snapshot's "loadedAt" beside a Refresh button
  When the app passes a "freshAfter" of the time the button was pressed
  Then the app receives an answer whose "loadedAt" is at or after that time
  And a copy loaded at or after the floor answers without reloading
```

- **Notes:** In the cloud each warm function holds its own copy, and the floor reaches whichever one answers.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DATA-080] A Refresh floor that is not a finite time is refused before any load
  Given an app developer's app queries its snapshot
  When the app passes a "freshAfter" of NaN or Infinity
  Then the query fails with a range error that reads "freshAfter must be a finite number of epoch milliseconds"
  And no load starts
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DATA-081] Each member's copy answers only that member's queries
  Given two members use an app developer's app in the cloud
  When the app's route handles a snapshot query from each member
  Then each answer holds only that member's rows
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DATA-082] A statement that would change the copy is refused, and the copy stays whole
  Given an app developer's app queries its snapshot
  When the app runs "UPDATE sets SET reps = 0", "DELETE FROM sets", "DROP TABLE sets", or a WITH that leads into a write
  Then the query fails with a SnapshotReadOnlyError
  And the next read of the copy returns every set unchanged
```

- **Notes:** A statement that does not begin with SELECT, WITH, or VALUES fails before it runs with "a snapshot runs only reads: the statement must begin with SELECT, WITH or VALUES". A write that slips past the keyword check fails with "the statement tried to change the snapshot; only reads may run". Comments and whitespace before the keyword are fine. Never run SQL text that arrived from the browser.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DATA-083] A copy over 200,000 rows is refused, and nothing is cached
  Given an app developer's app holds more than 200,000 rows in the tables a snapshot names
  When the app queries the snapshot with the default limit
  Then the query fails with a SnapshotTooLargeError that reads "the snapshot would hold more than 200000 rows; raise maxRows or aggregate on the data server with the row grammar instead"
  And the next query starts a fresh load
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DATA-084] The helper keeps 16 copies and reloads the least recently used one on its next query
  Given an app developer's app holds 16 cached snapshots with the default limit
  When the app queries a seventeenth set of tables
  Then the app's next query of the least recently used set loads again and answers with a new "loadedAt"
```

- **Notes:** A copy is keyed by the member and the set of tables, whatever their order.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DATA-085] A request from another site is refused
  Given an app developer's app serves an analysis route through the snapshot helper
  When the app's route handles a request that a page on another site sent
  Then the query fails with a SnapshotAccessError of status 403 and the message "Cross-site request refused"
  And no load starts
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DATA-086] A request with no session is refused before any load
  Given an app developer's app serves an analysis route through the snapshot helper in the cloud
  When the app's route handles a request that carries no session
  Then the query fails with a SnapshotAccessError of status 401 and the message "Not authenticated"
  And no load starts
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DATA-087] An app that is not installed gets an answer that says to install it
  Given an app developer runs the app "planner" on a computer or a cloud where planner is not installed
  When the app's analysis route queries a snapshot that needs a load
  Then the query fails with a SnapshotAccessError of status 503 and the message "planner has not been installed — run install from admin-web first"
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DATA-088] An app learns the data server's status when a load fails, and its next query loads again
  Given an app developer's app has no cached snapshot of "sets", and the data server will refuse a page of the load
  When the app queries the snapshot of "sets"
  Then the query fails with a SnapshotLoadError that carries the data server's status and message
  And the app's next query starts a fresh load
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DATA-089] A query that names an undeclared table is refused before any load
  Given an app developer's app creates its snapshot helper with the tables its manifest declares
  When the app queries a snapshot of "budgets", which is outside that list of "sets" and "goals"
  Then the query fails before any row loads, with an error that reads "\"budgets\" is not a declared table; declared: sets, goals"
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DATA-090] Booleans read as 1 or 0 in the copy, and an empty table still has its columns
  Given an app developer's app declares a boolean "done" column and an empty "goals" table
  When the app queries the snapshot
  Then "done" reads as 1 or 0 in the SQL answer
  And "SELECT * FROM goals" answers with no rows instead of failing
```

- **Notes:** A JSON object value is stored as JSON text, and a key the manifest does not declare is ignored.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [APP-DATA-091] Queries that arrive together share one load
  Given an app developer's app has no cached snapshot of "sets"
  When the app's route handles two queries of "sets" at the same moment
  Then both answers carry the same "loadedAt"
  And a request whose Refresh floor is newer than that load waits for a second load
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DATA-092] The helper hands back a refreshed session cookie for the app to return
  Given an app developer's app serves a member whose ID token needs renewing
  When the app queries its snapshot for that member
  Then the result carries "setCookie", which the app appends to its response
  And the member's next request carries the renewed session
```

## Background jobs

A background job is work an app runs for one member in the cloud without the member's browser, such as a nightly import from another service. The app declares each job in its manifest, and each member turns each job on separately. The manifest rules and the install dialog's jobs panel belong to [app-lifecycle.md](app-lifecycle.md) (APP-LIFE-183, APP-LIFE-019). The examples use an app named "Planner" (app id "planner") with a read-and-write job "fetch-workouts" whose default time is 06:30 and whose sentence is "Pulls yesterday's workouts from your provider."

### Turning a job on

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DATA-093] A member turns a job on at a daily time in their own zone and returns to the app
  Given a member opens Planner's link to turn on "fetch-workouts" from a browser in the Europe/London zone
  When the member keeps "Every day at 06:30", chooses "Sign in and turn the job on", and signs in
  Then the member sees "Background job on" and "Planner will run fetch-workouts every day at 06:30 (Europe/London)."
  And the page's "Back to Planner" link returns to the Planner page the member came from
```

- **Notes:** The page also links to "Your connections". The consent and connections pages answer only on the gateway's own host (ACCESS-134 in [users-and-access.md](users-and-access.md)).

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DATA-094] A member reads on the consent page what the job does, what each run may do, and how to turn it off
  Given Planner, a cloud app, offers the read-and-write job "fetch-workouts"
  When a member opens Planner's consent link for "fetch-workouts"
  Then the page "Turn on a background job" reads "Planner asks to run its job fetch-workouts for you in the cloud."
  And it shows "Pulls yesterday's workouts from your provider."
  And it reads "Each run may read and change your data in Planner. The job keeps running until you turn it off on your connections, or until you sign out everywhere."
  And "Every day at" is chosen with 06:30 filled in, and the "Time zone" list shows the browser's zone
```

- **Notes:** A read-mode job reads "Each run may read your data in Planner." The zone list offers UTC first, then every zone the runtime knows.

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DATA-095] A job with no default time offers "Only when I ask" first and runs only when the member asks
  Given Planner declares a job "tidy" with no default time
  When a member opens the consent link for "tidy", keeps "Only when I ask", and signs in
  Then the member sees "Planner will run tidy whenever you ask."
  And the connections page shows the job's schedule as "Only when you ask"
  And the job never runs on its own
```

```gherkin
@cloud
@intent:confirmed
Scenario Outline: [APP-DATA-096] A member gets UTC for an unknown zone and a link back to the app's root for a return path outside the app
  Given a member follows Planner's consent link for "fetch-workouts" with <link part>
  When the member keeps the page's choices and turns the job on
  Then <outcome>

  Examples:
    | link part                         | outcome                                                     |
    | the zone "Mars/Olympus"           | the member sees "Planner will run fetch-workouts every day at 06:30 (UTC)." |
    | the return path "/apps/other/x"   | "Back to Planner" leads to the app's root, "/apps/planner/" |
    | the return path "https://evil.example/" | "Back to Planner" leads to the app's root, "/apps/planner/" |
```

```gherkin
@cloud
@intent:confirmed
Scenario Outline: [APP-DATA-097] A link to a job the app does not offer, or a malformed link, shows a message instead of the form
  Given a member uses Planner in the cloud
  When the member follows a consent link that names <job>
  Then the member sees "<message>" and no form

  Examples:
    | job                                       | message                                  |
    | the job "backup", which Planner does not declare | Planner offers no job called backup here. |
    | no job                                    | This link names no job.                  |
```

- **Notes:** An app that has no cloud web app offers no job either.

```gherkin
@cloud
@intent:confirmed
Scenario Outline: [APP-DATA-098] An approval from another site or with an expired form is refused
  Given a member opened the consent page for "fetch-workouts"
  When the member submits an approval of "fetch-workouts" <how>
  Then the member sees "<message>"
  And the job stays off

  Examples:
    | how                                         | message                                                  |
    | through a page on another site              | This request did not come from the consent page.         |
    | from a consent page left open until its form expired | This form has expired. Open the consent page again.      |
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DATA-099] Choosing a daily time without a time is refused
  Given a member opens the consent page for "fetch-workouts"
  When the member clears the time, keeps "Every day at", and chooses "Sign in and turn the job on"
  Then the member sees "Pick a time of day, or choose to run the job only when you ask."
  And the job stays off
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DATA-100] A job the app dropped during the sign-in is not turned on
  Given a member approved "fetch-workouts" on the consent page
  And a cloud operator updated Planner to a version without "fetch-workouts" while the member was signing in
  When the member finishes signing in
  Then the member sees "Planner offers no job called fetch-workouts here."
  And the connections page lists no "fetch-workouts" job
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DATA-101] Turning a stopped job on again resumes it with the new choices
  Given a member's "fetch-workouts" job shows as stopped on the connections page
  When the member follows "Turn it on again", picks 07:15, and signs in
  Then the connections page shows "fetch-workouts" every day at 07:15 with no warning
  And the job runs at 07:15
```

- **Notes:** The job's earlier sign-in ends at once, so only the new approval acts for the member. The last run stays listed until the next run.

### The connections page

The connections page's "Background jobs" section lists the member's jobs. Outside-client tokens on the same page belong to [users-and-access.md](users-and-access.md) (ACCESS-144).

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DATA-102] A member sees each job's schedule and last run on the connections page
  Given a member turned on Planner's "fetch-workouts" at 06:30 in Europe/London, and it has not run yet
  When the member opens the connections page
  Then the "Background jobs" section shows a row for "fetch-workouts" with the schedule "Every day at 06:30" and "Europe/London"
  And the row's last run reads "Never"
  And the row offers "At" a time or "Only when I ask" with "Change time", and a "Turn off" button
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DATA-103] A member with no jobs reads "No app runs a background job for you."
  Given a member has turned on no background job
  When the member opens the connections page
  Then the "Background jobs" section reads "No app runs a background job for you."
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DATA-104] A member sees each job's app by its name on the connections page
  Given a member turned on a job of the app named "Planner", whose app id is "planner"
  When the member opens the connections page
  Then the job's row shows "Planner" in the App column
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DATA-105] A member reads the last run's time in the job's own zone on the connections page
  Given a member in America/Los_Angeles turned on "fetch-workouts", and it last ran at 06:30 local time on 23 November 2026
  When the member opens the connections page
  Then the job's last run reads "Succeeded on Mon, 23 Nov 2026, 06:30 (America/Los_Angeles)"
```

- **Notes:** the platform stores every time in UTC and converts it to the member's zone only for display.

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DATA-106] A member changes a job's time on the connections page
  Given a member's "fetch-workouts" job runs every day at 06:30 in Europe/London
  When the member sets 21:00 and chooses "Change time"
  Then the connections page shows "Every day at 21:00" with the same zone
  And the job's next run happens at 21:00
```

- **Notes:** Choosing "Only when I ask" stops the daily runs and keeps the job on. The page keeps the job's zone. A change without a time shows "Pick a time of day, or choose to run the job only when you ask." A new time on a stopped job takes effect once the member turns the job on again.

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DATA-107] A member turns a job off, and the job no longer runs
  Given a member's "fetch-workouts" job is on
  When the member chooses "Turn off" for "fetch-workouts" on the connections page
  Then the "Background jobs" section no longer lists "fetch-workouts"
  And Planner shows "fetch-workouts" as off, and its "Run now" is refused until the member turns the job on again
```

- **Notes:** Turning a job off also ends the sign-in the job held.

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DATA-108] A failed last run shows its message on the connections page until a later run succeeds
  Given a member's last "fetch-workouts" run failed, and Planner answered with the message "Provider refused the token"
  When the member opens the connections page
  Then the row's last run reads "Failed on <time>" with "The last run failed: Provider refused the token"
  And after a later run succeeds, the row reads "Succeeded on <time>" with no warning
```

- **Notes:** A failed run with no message reads "The last run failed." The page keeps at most 500 characters of a message.

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DATA-109] A member's "Turn it on again" opens the job's consent page in the job's zone
  Given a member's "fetch-workouts" job shows as stopped with "Turn it on again"
  When the member follows "Turn it on again"
  Then the consent page for Planner's "fetch-workouts" opens with the job's stored zone chosen
```

```gherkin
@cloud
@intent:confirmed
Scenario Outline: [APP-DATA-110] A change from another site or for another member's job changes nothing
  Given a member's "fetch-workouts" job is on
  And <who> sent a "Change time" or "Turn off" for the job
  When the member opens the connections page
  Then the page still shows "fetch-workouts" with its old schedule

  Examples:
    | who                                                    |
    | a page on another site, in the member's browser        |
    | a form without the page's current token                |
    | a second member, naming the first member's job         |
```

### When a job runs

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DATA-111] A job runs every day at the member's time, up to five minutes late
  Given a member turned on "fetch-workouts" at 06:30 in Europe/London, and each run of "fetch-workouts" finishes within a minute
  When the member opens the connections page at 06:40 London time on the next morning, in December
  Then the row's last run reads "Succeeded on" that morning, at a time between 06:30 and 06:36 (Europe/London)
```

- **Notes:** The platform wakes every five minutes, so a run may start up to five minutes after its time. When more runs are due than the cloud runs at once, a run waits for a later wake (APP-DATA-131).

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DATA-112] A time skipped by a spring-forward clock change runs at the end of the gap
  Given an app developer's app "planner" serves a member in America/Los_Angeles who turned on "fetch-workouts" at 02:30
  When the app's job route handles that member's runs on the day the clocks jump from 02:00 to 03:00
  Then the app receives one scheduled run that day, whose "scheduledFor" is 03:00 local time
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DATA-113] A time repeated by a fall-back clock change runs once
  Given an app developer's app "planner" serves a member in Europe/London who turned on "fetch-workouts" at 01:30
  When the app's job route handles that member's runs on the day the clocks fall back from 02:00 to 01:00
  Then the app receives one scheduled run that day, whose "scheduledFor" is the first 01:30
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DATA-114] A job stops when the member signs out everywhere or a cloud operator disables the account
  Given a member's "fetch-workouts" job is on
  And a cloud operator chose "Sign out all devices" for the member, or disabled the member's account and enabled it again
  When the member opens the connections page after the job's next time
  Then the row's last run reads "Stopped on <time>"
  And the row reads "You signed out everywhere, or your account was disabled. Turn the job on again to resume it." with "Turn it on again"
  And the job does not run again until the member turns it on again
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DATA-115] A job stops when the member loses the data library
  Given a member's "fetch-workouts" job is on
  And a cloud operator cleared the member's "Data" box in admin-web before the job's time and checked it again afterwards
  When the member opens the connections page after the job's next time
  Then the row reads "Your account has no data library on this cloud, so the job cannot reach your data." with "Turn it on again"
  And the job does not run again until the member turns it on again
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DATA-116] A job stops for the member's approval when an update widens its access
  Given a member turned on Planner's "fetch-workouts" while it asked to read the member's data
  And a cloud operator updated Planner to a version where "fetch-workouts" asks to read and change the member's data
  When the member opens the connections page after the job's next time
  Then the row reads "The app changed this job since you turned it on. Turn it on again to approve the change." with "Turn it on again"
  And the job does not run again until the member turns it on again
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DATA-159] A member whose job an update dropped reads that the app no longer offers it
  Given a member turned on Planner's "fetch-workouts" in Europe/London, and it last ran at 06:30 on 23 November 2026
  And a cloud operator updated Planner to a version that no longer offers "fetch-workouts"
  When the member opens the connections page after the job's next time
  Then the row says that Planner no longer offers "fetch-workouts" and that the job no longer runs
  And the row shows the last run as "Mon, 23 Nov 2026, 06:30 (Europe/London)"
  And the row offers "Remove" and no link to the consent page
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DATA-117] A job keeps running at the narrower access when an update narrows it
  Given a member turned on Planner's "fetch-workouts" while it asked to read and change data
  And a cloud operator updated Planner to a version where "fetch-workouts" asks only to read
  When the member opens the connections page after the job's next time
  Then the row's last run reads "Succeeded on <time>" with no warning
```

- **Notes:** The run gets only the narrower access the new version asks for.

```gherkin
@cloud
@intent:confirmed
Scenario Outline: [APP-DATA-118] A run the cloud cannot start right now is postponed to the next wake
  Given a member's "fetch-workouts" job came due while <cause>
  When the member opens the connections page right after
  Then the row's last run reads "Postponed on <time>" with no warning
  And the job runs at the next wake, within five minutes

  Examples:
    | cause                                                 |
    | the deployment's sign-in service did not answer       |
    | the cloud refused to start the app's function because it was busy |
```

- **Notes:** The app's job list carries the reason: "Sign-in was unavailable. The job runs on the next tick." or "The cloud was busy. The job runs on the next tick." A postponed run is no failure.

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DATA-119] A run that Planner reports as failed for good waits for the job's next time
  Given a member's daily "fetch-workouts" job failed at 06:30, and Planner did not report the failure as temporary
  When the member opens the connections page at noon
  Then the row still shows "The last run failed: <message>"
  And the job next runs at 06:30 the next day, unless the member starts it sooner from Planner
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DATA-160] A run that Planner reports as temporarily failed runs again well before the job's next time
  Given a member's daily "fetch-workouts" job failed at 06:30, and Planner reported the failure as temporary
  When the member opens the connections page at noon
  Then the job ran again after 06:30, without the member's help
  And the row shows the latest run's outcome
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DATA-157] A member sees a successful run's message beside the run on the connections page
  Given a member's "fetch-workouts" job last ran and Planner answered with success and the message "3 new workouts"
  When the member opens the connections page
  Then the row's last run reads "Succeeded on <time>" with "3 new workouts" beside it
```

- **Notes:** Implementation gap: the connections page shows a run's message only after a failed run.

### Starting and running jobs from the app

An app's server calls `listJobs`, `runJobNow`, and `jobConsentUrl` from `@starkeep/app-client` with the signed-in member's token. The platform runs each job by calling the app's own route `POST /apps/<appId>/_starkeep/jobs/<name>`.

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DATA-120] An app lists its jobs with the member's state and a consent link that carries the zone and return path
  Given an app developer's app "planner" declares the jobs "fetch-workouts" and "tidy", and the member turned on "fetch-workouts"
  When the app's server calls listJobs("planner", { userToken }) and then jobConsentUrl(job, { timeZone: "Europe/London", returnTo: "/apps/planner/settings" })
  Then listJobs answers "cloudRequired" false with both jobs
  And "fetch-workouts" carries "enabled" true, its time and zone, "nextRunAt", "running", "lastRun", and "attention"
  And "tidy" carries "enabled" false
  And the consent link names the job, the zone, and the return path
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DATA-121] An app starts a run now and gets the run's id
  Given an app developer's app "planner" serves a member whose "fetch-workouts" job is on
  When the app's server calls runJobNow("planner", "fetch-workouts", { userToken })
  Then the app receives { ok: true, runId }
  And the app's job route receives the run with "trigger" "manual" and the same run id
  And the job's daily time stays as it was
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DATA-122] Run now is refused until the member turns the job on
  Given an app developer's app serves a member who never turned "fetch-workouts" on, or turned it off
  When the app's server calls runJobNow for "fetch-workouts"
  Then the app receives { ok: false, status: 409, code: "not-enabled", error: "Turn the job on first" }
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DATA-123] Run now is refused while a run is under way
  Given an app developer's app serves a member whose "fetch-workouts" run is under way
  When the app's server calls runJobNow for "fetch-workouts"
  Then the app receives { ok: false, status: 409, code: "running", error: "The job is running" }
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DATA-124] Run now is refused for a stopped job, with the reason
  Given an app developer's app serves a member whose "fetch-workouts" job stopped because a cloud operator signed the member out of all devices
  When the app's server calls runJobNow for "fetch-workouts"
  Then the app receives { ok: false, status: 409, code: "signed-out", error: "The job is stopped until you turn it on again" }
```

- **Notes:** The code is the stop's reason: "signed-out", "no-library", or "needs-consent". A run now on a job whose current version asks for more than the member approved stops the job and answers "needs-consent" with "The app changed this job since you turned it on. Turn it on again to approve the change."

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DATA-125] Run now on a failed job still runs
  Given an app developer's app serves a member whose last "fetch-workouts" run failed
  When the app's server calls runJobNow for "fetch-workouts"
  Then the app receives { ok: true, runId }
  And a successful run clears the job's failure
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DATA-126] Run now that the cloud cannot start fails, and the run shows as failed
  Given an app developer's app serves a member whose "fetch-workouts" job is on
  And the cloud cannot start the run at that moment
  When the app's server calls runJobNow for "fetch-workouts"
  Then the app receives { ok: false, status: 503, error: "The job could not start. Try again." }
  And listJobs shows the last run as failed with "The job could not start. Try again."
  And a later runJobNow call may start a run
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DATA-127] Run now for a job the app does not declare gets a not-found answer
  Given an app developer's app "planner" declares no job called "backup"
  When the app's server calls runJobNow for "backup"
  Then the app receives a not-found answer that reads "planner has no job backup"
```

- **Notes:** An app installed in the cloud without a web app has no cloud server to call listJobs or runJobNow, so only a direct call to the route meets its "planner has no cloud web app here" answer.

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DATA-128] The app's job route receives each run with its member, trigger, and token
  Given an app developer's app mounts its "fetch-workouts" route ahead of its session gate and calls verifyJob(request, "fetch-workouts")
  When the app's route handles a member's daily run of "fetch-workouts"
  Then the app receives POST /apps/planner/_starkeep/jobs/fetch-workouts with the body { job, runId, trigger: "schedule", scheduledFor }
  And verifyJob returns the member's id, the job, the run id, the mode, and the run's token
```

- **Notes:** The app forwards the token on every data call, through `signedFetch`'s `delegation` option, so the platform applies the job's mode to each call.

```gherkin
@cloud
@intent:confirmed
Scenario Outline: [APP-DATA-129] The app's answer decides the run's recorded outcome and message
  Given an app developer's app's "fetch-workouts" route <answer>
  When the app's route handles a run of "fetch-workouts" for a member
  Then the app's listJobs shows the run's "lastRun" with status "<status>" and message <message>

  Examples:
    | answer                                                   | status | message                                       |
    | answers 200 with {"message": "3 new workouts"}           | ok     | "3 new workouts"                              |
    | answers 204 with no body                                 | ok     | null                                          |
    | answers 502 with {"message": "Provider said no"}         | failed | "Provider said no"                            |
    | answers 500 with no JSON message                         | failed | "The app answered 500."                       |
    | throws the error "boom"                                  | failed | "The app's function failed: boom"             |
    | returns something that is not an HTTP response           | failed | "The app's function failed: the function returned no HTTP response" |
```

- **Notes:** A run that outlasts the handler's timeout fails as a function error. A job's handler may declare at most 840 seconds (APP-LIFE-183). The platform keeps at most 500 characters of a message.

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DATA-130] Two runs of one job for one member never overlap
  Given an app developer's app's "fetch-workouts" job rotates a provider token on every run
  And a member's scheduled run of "fetch-workouts" is under way
  When the app's server calls runJobNow for "fetch-workouts" for that member
  Then runJobNow answers { ok: false, status: 409, code: "running", error: "The job is running" }
  And the app's route never handles two runs of "fetch-workouts" for that member at once
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DATA-131] At most two runs proceed at once across the deployment, and the rest wait for the next wake
  Given an app developer's app has three members whose jobs come due at the same minute, and no other run is under way
  When the app developer reads each member's job with listJobs after the next wake and again after the one after it
  Then at most two of the jobs show a run started at the first wake, the soonest due first
  And the third job shows a run started at a later wake
```

- **Notes:** The bound is soft: two wakes that overlap can each start one run past it.

### Job tokens

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DATA-132] A run's token reads and writes only its member's data, within the job's mode
  Given an app developer's app runs a read-and-write job for one of two members
  When the app's job route writes and reads its "notes" table with the run's token
  Then the write lands as the run's member's row
  And the read returns that member's rows and none of the other member's
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DATA-133] A read-mode run reads rows and adds labels but cannot write rows
  Given an app developer's app declares a read-mode job
  When the app's job route reads rows, adds a label, and then writes a row with the run's token
  Then the reads and the label succeed
  And the row write fails as forbidden with "A read job may not call POST /app-data/db/notes"
```

- **Notes:** No run's token erases a file's bytes, deletes an app-private file, restores from the Trash, thaws, syncs, or reads the Trash, whatever the mode.

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DATA-134] A run's token stops working once the run ends
  Given an app developer's app's job run answered and the run ended
  When the app makes a data call with that run's token
  Then within a minute of the run's end the call fails as unauthorized with "This job run has ended or was turned off"
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DATA-135] A run under way when its member is signed out everywhere may finish, and the job then stops
  Given an app developer's app's run of "fetch-workouts" is under way for a member
  And a cloud operator chose "Sign out all devices" for the member
  When the app's job route makes its next data calls with the run's token
  Then the calls may keep succeeding until the run ends
  And the app's listJobs shows "fetch-workouts" with "attention" "signed-out"
  And the app's runJobNow for "fetch-workouts" is refused until the member turns the job on again
```

- **Notes:** A member who lost the data library is refused as forbidden with "This account has no data library on this cloud". While the sign-in service does not answer, a call fails with status 503 and "Sign-in is unavailable right now. Try again."

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DATA-136] A run's token cannot list or start jobs
  Given an app developer's app's job run holds its token
  When the app's job route lists jobs or starts a run now with the run's token
  Then both calls fail as forbidden
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DATA-158] A run's token opens no route declared for outside clients
  Given an app developer's app declares a route with auth "delegated" for outside clients
  When the app's job run calls that route with its token
  Then the app's call fails as unauthorized
  And verifyDelegation returns no delegation for the token
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DATA-137] A token that is not this job's run is refused by verifyJob, and the app answers not found
  Given an app developer's app's "fetch-workouts" route calls verifyJob(request, "fetch-workouts") and answers jobRefusal() when it returns null
  When the app's route handles a request that carries another job's token, an outside client's token, or a token without its run
  Then verifyJob returns null
  And the app answers the request with 404 and {"error": "Not found"}, so the request learns nothing about the app's jobs
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DATA-138] Nobody outside the platform reaches an app's job route
  Given an app developer's app serves POST /apps/planner/_starkeep/jobs/fetch-workouts
  When the app developer sends a request to that path through the deployment's address or the gateway's own address, signed in or not
  Then the request gets a not-found answer
  And the app's route never receives it
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DATA-139] A computer's sign-in and an outside client's token cannot list or start jobs
  Given an app developer's app "planner" has a member whose "fetch-workouts" job is on
  When the app developer lists Planner's jobs or starts "fetch-workouts" with a computer's sign-in as the member, or with an outside client's token for Planner
  Then the call fails as forbidden
  And no run starts
```

### Jobs on a computer

```gherkin
@local
@intent:confirmed
Scenario: [APP-DATA-140] On a computer, an app learns that background jobs need a cloud
  Given an app developer's app runs on a member's computer
  When the app's server calls listJobs or runJobNow, or the app's job route calls verifyJob
  Then listJobs answers { cloudRequired: true, jobs: [] } and runJobNow answers { ok: false, cloudRequired: true }
  And verifyJob returns null for every request
```

- **Notes:** The local data server answers a signed job call with status 501 and the code "cloud-required", and refuses an unsigned one. Probe's page and the example app's page both say that background jobs need a cloud.

## The credential vault

The vault keeps one encrypted secret per member, app, and name in the cloud, such as a provider's refresh token. The app's server stores, lists, and deletes a member's secrets with the member's token, and only a run of one of the app's jobs reads a value. The app client's `putSecret`, `listSecrets`, `deleteSecret`, and `readSecret` make the calls.

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DATA-141] An app stores a member's secret and lists its name and time, never its value
  Given an app developer's app "planner" offers a "Connect provider" form to a signed-in member
  When the app's server calls putSecret("planner", "provider", value, { userToken }) and then listSecrets("planner", { userToken })
  Then putSecret answers { ok: true }
  And listSecrets answers the entry "provider" with its "updatedAt" time and no value
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DATA-142] An app's server cannot read a member's secret back
  Given an app developer's app stored a member's secret "provider"
  When the app's server asks for GET /vault/provider with the member's token
  Then the call fails as forbidden with "Only the app's scheduled jobs read a secret"
  And the answer holds no part of the value
```

- **Notes:** A page can therefore show "connected" but never the credential.

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DATA-143] A run reads its member's secret and stores a rotated value
  Given an app developer's app stored a member's secret "provider"
  When the app's job run calls readSecret("planner", "provider", { delegation: run.token }) and then putSecret with a new value and the run's token
  Then readSecret answers { ok: true, value } with the stored value
  And the member's next run reads the new value
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DATA-144] A run reads a secret that was never stored as empty
  Given an app developer's app never stored a secret "provider" for a member
  When the app's job run calls readSecret for "provider"
  Then readSecret answers { ok: true, value: null }
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DATA-145] A run cannot list or delete secrets
  Given an app developer's app stored a member's secret "provider"
  When the app's job run lists the member's secrets or deletes "provider" with the run's token
  Then both calls fail as forbidden with "This caller may not reach the vault this way"
  And the secret stays stored
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DATA-146] An app deletes a member's secret, and the next run finds none
  Given an app developer's app stored a member's secret "provider"
  When the app's server calls deleteSecret("planner", "provider", { userToken })
  Then deleteSecret answers { ok: true }
  And the member's next run reads "provider" as null
```

- **Notes:** Deleting a secret that does not exist answers the same success.

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DATA-147] One member's run never reads another member's secret
  Given an app developer's app stored the secret "provider" for two members with different values
  When the app's job runs for each member read "provider"
  Then each run receives only its own member's value
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DATA-148] An outside client's token and a computer's sign-in reach no vault route
  Given an app developer's app stored a member's secret "provider"
  When the app developer lists, reads, stores, or deletes the app's secrets with an outside client's token for the app, or with a computer's sign-in as the member
  Then every call fails as forbidden
  And the secret stays stored, unread
```

```gherkin
@cloud
@intent:confirmed
Scenario Outline: [APP-DATA-149] An empty or oversized secret is refused
  Given an app developer's app offers a "Connect provider" form
  When the app's server calls putSecret for "provider" with <value>
  Then putSecret answers { ok: false, status: 400, error: "<message>" }
  And no secret is stored

  Examples:
    | value                      | message                             |
    | an empty string            | A secret is a non-empty string.     |
    | a value of 4,097 bytes     | A secret holds at most 4096 bytes.  |
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DATA-150] A malformed secret name gets a bad-request answer that states the naming rule
  Given an app developer's app offers a "Connect provider" form
  When the app's server calls putSecret, or a run calls readSecret, with the name "Bad.Name"
  Then the call answers { ok: false, status: 400 } with the error "A secret's name is lowercase letters, digits, _ and -, at most 64 characters."
  And no secret is stored
```

- **Notes:** A name is lowercase letters, digits, `_`, and `-`, starts with a letter or digit, and holds at most 64 characters.

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DATA-151] A secret keeps rotating past a hundred versions
  Given an app developer's app's job rotates a provider token on every run
  When the app's job rotates the secret on each of 150 runs
  Then each run still stores the new value
  And readSecret answers the latest value
```

- **Notes:** The cloud keeps 100 versions of a secret and deletes the oldest on each write. The platform never labels a version, because a labelled oldest version would stop every later write.

```gherkin
@local
@intent:confirmed
Scenario: [APP-DATA-152] On a computer, every vault call reports that the vault needs a cloud
  Given an app developer's app runs on a member's computer
  When the app's server calls putSecret, listSecrets, deleteSecret, or readSecret
  Then each call answers { ok: false, cloudRequired: true }
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DATA-153] A cloud operator's AWS access can delete members' secrets but never read one
  Given a cloud operator acts through the AWS access that the cloud operator's admin-web sign-in may take on
  And an app holds a member's secret in the vault
  When the cloud operator lists the vault's parameters, asks for the secret's value, and deletes the secret in Parameter Store
  Then the cloud operator sees the secret's name in the list
  And the request for the value is denied
  And the deletion succeeds
```

- **Notes:** An app's own function cannot reach the vault directly either, because an app reads only its own credential parameter and no app id starts with `_`. Only a job run, through the data server, reads a value.

## Uninstalling an app that has jobs or secrets

A cloud uninstall deletes every member's job enrollments and vault secrets for the app, so a reinstall starts with every job off and no secret. The app's own rows stay, as [app-lifecycle.md](app-lifecycle.md) states (APP-LIFE-155).

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DATA-154] After a cloud uninstall and reinstall, the member's jobs for the app are off and show no run
  Given a member turned on Planner's "fetch-workouts", and it ran
  And a cloud operator uninstalled Planner from the cloud and installed it again
  When the member opens the connections page
  Then the "Background jobs" section lists no Planner job
  And Planner shows "fetch-workouts" as off with no last run, until the member turns it on again
```

```gherkin
@cloud
@intent:confirmed
Scenario: [APP-DATA-155] After a cloud uninstall and reinstall, the app finds none of its members' secrets
  Given an app developer's app "planner" stored secrets for two members
  And a cloud operator uninstalled the app from the cloud and installed it again
  When the app's server calls listSecrets for each member
  Then each call answers an empty list
  And each member's job run reads every former secret as null
```

- **Notes:** The uninstall removes the secrets in a step of its own, so a rerun of a failed uninstall finishes the sweep.

## Kept app data

An app's rows and private files outlive an uninstall, on a computer and in the cloud. These behaviors belong to [app-lifecycle.md](app-lifecycle.md): a reinstall bringing kept rows back (APP-LIFE-142 on a computer, APP-LIFE-155 in the cloud), Delete data and whether the cloud holds a copy (APP-LIFE-146), `cli:delete-app-data` (APP-LIFE-160), and an update that adds tables and indexes (APP-LIFE-076). How rows reach the member's other devices belongs to [sync.md](sync.md).
