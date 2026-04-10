# @starkeep/storage-adapter

Abstract interfaces for database and object storage, plus in-memory mock implementations
for testing. All storage packages implement these interfaces.

## DatabaseAdapter

The interface for all structured data operations. Implementations exist for SQLite (local)
and Aurora DSQL (cloud).

```typescript
import { type DatabaseAdapter } from "@starkeep/storage-adapter"
```

### Data record operations

| Method | Description |
|--------|-------------|
| `init()` / `close()` | Lifecycle — open and close the connection |
| `healthCheck()` | Verify the connection is healthy |
| `put(record)` | Insert or replace a data record |
| `get(id)` | Fetch a data record by ID |
| `delete(id)` | Remove a data record |
| `query(query)` | Query with filters, sorting, and cursor-based pagination |
| `batch(operations)` | Execute multiple operations atomically |
| `transaction(callback)` | Run a block of operations in a transaction |
| `runMigrations(migrations)` | Apply schema migrations |

### Query model

```typescript
import { type Query, type Filter } from "@starkeep/storage-adapter"

const results = await adapter.query({
  type: "tasks:task",            // filter by record type
  filters: [
    { field: "content.status", operator: "eq", value: "todo" },
    { field: "createdAt", operator: "gte", value: someTimestamp },
  ],
  sort: [{ field: "updatedAt", direction: "desc" }],
  limit: 50,
  cursor: previousResult.nextCursor,
})
```

Filter operators: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in`, `like`

### Per-type metadata table operations

Metadata is stored in separate tables — one per data record type — rather than in the
main `records` table. Each table has typed columns per generator.

| Method | Description |
|--------|-------------|
| `ensureMetadataTable(targetType, generatorId, columns)` | Create the metadata table and add the generator's columns if missing. Idempotent. Called at init time by the SDK for each registered generator. |
| `putMetadata(targetType, entry)` | Upsert one generator's output for a target record. Only the generator's own columns are written. |
| `queryMetadata(targetType, query)` | Query entries from a type's metadata table. |

```typescript
import { type MetadataColumnDefinition, type MetadataQuery } from "@starkeep/storage-adapter"

// Declaring columns in a generator definition:
const outputColumns: MetadataColumnDefinition[] = [
  { name: "status", columnType: "text" },
  { name: "comment_count", columnType: "integer" },
]

// Querying metadata:
const result = await adapter.queryMetadata("tasks:task", {
  targetIds: [recordId1, recordId2],
  generatorId: "tasks:properties",
  filters: [{ field: "status", operator: "eq", value: "done" }],
})
```

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
