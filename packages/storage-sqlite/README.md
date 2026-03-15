# @starkeep/storage-sqlite

SQLite implementation of `DatabaseAdapter` using the built-in `node:sqlite` module (Node.js 22+). No native compilation dependencies required.

## Installation

```bash
pnpm add @starkeep/storage-sqlite
```

Requires Node.js 22 or later for `node:sqlite` support.

## Usage

```typescript
import { SqliteDatabaseAdapter } from "@starkeep/storage-sqlite";

// File-based database
const databaseAdapter = new SqliteDatabaseAdapter({ path: "./data/starkeep.db" });

// Or in-memory for testing
const memoryAdapter = new SqliteDatabaseAdapter({ path: ":memory:" });

await databaseAdapter.init();

// Use the standard DatabaseAdapter interface
await databaseAdapter.put(record);
const retrieved = await databaseAdapter.get(record.id);

const queryResult = await databaseAdapter.query({
  type: "photo",
  filters: [{ field: "owner_id", operator: "eq", value: "user-123" }],
  sort: [{ field: "updated_at", direction: "desc" }],
  limit: 20,
});

// Transactions with automatic rollback on failure
await databaseAdapter.transaction(async (transaction) => {
  await transaction.put(firstRecord);
  await transaction.put(secondRecord);
});

await databaseAdapter.close();
```

## API

| Export | Description |
|---|---|
| `SqliteDatabaseAdapter` | Class implementing `DatabaseAdapter` for SQLite |
| `SqliteDatabaseAdapterOptions` | Options type: `{ path: string \| ":memory:" }` |

The adapter automatically creates the `records` table, indexes, and a `migrations` table on `init()`. WAL journal mode and foreign keys are enabled by default.

## Testing

```bash
pnpm --filter @starkeep/storage-sqlite test
```
