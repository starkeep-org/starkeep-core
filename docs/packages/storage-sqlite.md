# @starkeep/storage-sqlite

SQLite implementation of `DatabaseAdapter` for local storage. Uses Node.js 22's built-in
`node:sqlite` module — no native bindings or external database server required.

**Use this when:** building a local-first or desktop app, running tests, or working offline.

## Usage

```typescript
import { SqliteDatabaseAdapter } from "@starkeep/storage-sqlite"

// File-backed database
const adapter = new SqliteDatabaseAdapter({ path: "./my-app.db" })

// In-memory (useful for tests)
const adapter = new SqliteDatabaseAdapter({ path: ":memory:" })

await adapter.init()  // creates tables and runs migrations
```

## Requirements

Node.js 22 or later (for `node:sqlite`).

## Notes

- Uses WAL mode for better concurrent read performance
- Transactions use SQLite SAVEPOINTs to support nesting
- Indexed on `type`, `kind`, `sync_status`, `target_id`, `updated_at` for query performance
