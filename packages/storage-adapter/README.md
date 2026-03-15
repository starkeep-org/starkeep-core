# @starkeep/storage-adapter

Abstract interfaces for database and object storage adapters, plus in-memory mock implementations for testing.

## Installation

```bash
pnpm add @starkeep/storage-adapter
```

## Usage

```typescript
import { MockDatabaseAdapter, MockObjectStorageAdapter } from "@starkeep/storage-adapter";
import type { DatabaseAdapter, ObjectStorageAdapter } from "@starkeep/storage-adapter";

// Use mock adapters for testing
const databaseAdapter: DatabaseAdapter = new MockDatabaseAdapter();
await databaseAdapter.init();

await databaseAdapter.put(record);
const retrieved = await databaseAdapter.get(record.id);
const queryResult = await databaseAdapter.query({ type: "photo", limit: 10 });

const objectStorage: ObjectStorageAdapter = new MockObjectStorageAdapter();
await objectStorage.init();

await objectStorage.put("photos/sunset.jpg", fileBuffer, { contentType: "image/jpeg" });
const result = await objectStorage.get("photos/sunset.jpg");
```

## API

### DatabaseAdapter Interface

| Method | Description |
|---|---|
| `init()` | Initialize the adapter (create tables, connect) |
| `close()` | Close connections and release resources |
| `healthCheck()` | Returns `true` if the adapter is operational |
| `put(record)` | Insert or upsert a record |
| `get(identifier)` | Retrieve a record by id, or `null` |
| `delete(identifier)` | Delete a record by id |
| `query(query)` | Query records with filters, sorting, and pagination |
| `batch(operations)` | Execute multiple put/delete operations atomically |
| `transaction(callback)` | Run operations inside a transaction |
| `runMigrations(migrations)` | Apply pending schema migrations |

### ObjectStorageAdapter Interface

| Method | Description |
|---|---|
| `init()` | Initialize the adapter |
| `close()` | Release resources |
| `healthCheck()` | Returns `true` if the adapter is operational |
| `put(key, data, options?)` | Store binary data with optional content type and metadata |
| `get(key)` | Retrieve stored data, or `null` |
| `delete(key)` | Remove an object by key |
| `list(prefix, options?)` | List object keys matching a prefix with pagination |
| `getSignedUrl?(key, options?)` | Generate a pre-signed URL (optional, adapter-dependent) |

### Mock Implementations

| Export | Description |
|---|---|
| `MockDatabaseAdapter` | In-memory database adapter for testing |
| `MockObjectStorageAdapter` | In-memory object storage adapter for testing |

### Error Types

| Export | Description |
|---|---|
| `StorageError` | General storage failure |
| `ConnectionError` | Connection failure |
| `TransactionError` | Transaction failure |
| `MigrationError` | Migration failure |
| `ObjectNotFoundError` | Object not found in storage |

### Key Types

`Query`, `QueryResult`, `Filter`, `SortField`, `SortDirection`, `BatchOperation`, `Migration`, `Transaction`, `PutOptions`, `GetResult`, `ListOptions`, `ListResult`, `SignedUrlOptions`

## Testing

```bash
pnpm --filter @starkeep/storage-adapter test
```
