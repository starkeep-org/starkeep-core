# @starkeep/storage-adapter

Abstract interfaces for database and object storage, plus in-memory mock implementations
for testing. All storage packages implement these interfaces.

## DatabaseAdapter

The interface for all structured data operations. Implementations exist for SQLite (local)
and Aurora DSQL (cloud).

```typescript
import { type DatabaseAdapter } from "@starkeep/storage-adapter"
```

Key operations:

| Method | Description |
|--------|-------------|
| `init()` / `close()` | Lifecycle — open and close the connection |
| `healthCheck()` | Verify the connection is healthy |
| `put(record)` | Insert or replace a record |
| `get(id)` | Fetch a record by ID |
| `delete(id)` | Remove a record |
| `query(query)` | Query with filters, sorting, and cursor-based pagination |
| `batch(operations)` | Execute multiple operations atomically |
| `transaction(callback)` | Run a block of operations in a transaction |
| `runMigrations(migrations)` | Apply schema migrations |

### Query model

```typescript
import { type Query, type Filter } from "@starkeep/storage-adapter"

const results = await adapter.query({
  type: "tasks:task",            // filter by record type
  kind: "data",                  // "data" or "metadata"
  filters: [
    { field: "payload.status", operator: "eq", value: "todo" },
    { field: "createdAt", operator: "gte", value: someTimestamp },
  ],
  sort: [{ field: "updatedAt", direction: "desc" }],
  limit: 50,
  cursor: previousResult.nextCursor,
})
```

Filter operators: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in`, `like`

## ObjectStorageAdapter

The interface for file and blob storage. Implementations exist for the local filesystem
and S3.

```typescript
import { type ObjectStorageAdapter } from "@starkeep/storage-adapter"
```

Key operations:

| Method | Description |
|--------|-------------|
| `init()` / `close()` | Lifecycle |
| `put(key, data, options?)` | Store a file |
| `get(key)` | Retrieve a file |
| `delete(key)` | Remove a file |
| `list(prefix, options?)` | List files by prefix |
| `getSignedUrl?(key, options?)` | Generate a pre-signed URL (optional, S3 only) |

## Mock implementations

For testing, both mocks store data in memory and reset between test runs:

```typescript
import { MockDatabaseAdapter, MockObjectStorageAdapter } from "@starkeep/storage-adapter"

const db = new MockDatabaseAdapter()
const storage = new MockObjectStorageAdapter()

await db.init()
await storage.init()
```

## Error types

```typescript
import {
  StorageError,
  ConnectionError,
  TransactionError,
  MigrationError,
  ObjectNotFoundError,
} from "@starkeep/storage-adapter"
```
