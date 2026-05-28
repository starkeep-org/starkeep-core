# @starkeep/storage-aurora-dsql

Amazon Aurora DSQL implementation of `DatabaseAdapter`. Designed for serverless PostgreSQL-compatible cloud storage.

## Installation

```bash
pnpm add @starkeep/storage-aurora-dsql
```

## Usage

```typescript
import { AuroraDsqlDatabaseAdapter } from "@starkeep/storage-aurora-dsql";
import type { DatabaseClientFactory } from "@starkeep/storage-aurora-dsql";

// Provide your own database client factory (e.g., wrapping pg, postgres, etc.)
const clientFactory: DatabaseClientFactory = {
  async createClient(options) {
    // Return an object with query(text, values) and end() methods
    return myPostgresClient;
  },
};

const databaseAdapter = new AuroraDsqlDatabaseAdapter(
  {
    hostname: "my-cluster.dsql.us-east-1.on.aws",
    region: "us-east-1",
    database: "starkeep",
  },
  clientFactory,
);

await databaseAdapter.init();

// Standard DatabaseAdapter interface
await databaseAdapter.put(record);
const retrieved = await databaseAdapter.get(record.id);

const queryResult = await databaseAdapter.query({
  type: "photo",
  sort: [{ field: "updated_at", direction: "desc" }],
  limit: 50,
});

await databaseAdapter.close();
```

## API

| Export | Description |
|---|---|
| `AuroraDsqlDatabaseAdapter` | Class implementing `DatabaseAdapter` for Aurora DSQL |
| `buildPostgresQuery(query)` | Compile a `Query` object into parameterized PostgreSQL via Kysely |
| `AuroraDsqlDatabaseAdapterOptions` | Options: `hostname`, `region`, optional `database` |
| `DatabaseClient` | Interface: `query(text, values)` and `end()` |
| `DatabaseClientFactory` | Factory interface for creating `DatabaseClient` instances |
| `BuiltPostgresQuery` | Return type of `buildPostgresQuery`: `{ text, values }` |

The adapter uses JSONB for the payload column and creates indexes on `type`, `sync_status`, `target_id`, `updated_at`, and `kind`.

## Testing

```bash
pnpm --filter @starkeep/storage-aurora-dsql test
```
