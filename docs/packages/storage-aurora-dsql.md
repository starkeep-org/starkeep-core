# @starkeep/storage-aurora-dsql

Aurora DSQL implementation of `DatabaseAdapter` for cloud storage. Aurora DSQL is
AWS's PostgreSQL-compatible serverless database with distributed transactions.

**Use this when:** deploying a user's cloud stack. In the full architecture, each user
gets their own Aurora DSQL cluster.

## Usage

```typescript
import {
  AuroraDsqlDatabaseAdapter,
  type DatabaseClientFactory,
} from "@starkeep/storage-aurora-dsql"

const adapter = new AuroraDsqlDatabaseAdapter(
  {
    hostname: "cluster.xxx.us-east-1.dsql.amazonaws.com",
    region: "us-east-1",
  },
  clientFactory,
)

await adapter.init()
```

## DatabaseClientFactory

You provide the PostgreSQL client implementation. This lets you bring your own `pg`
or AWS SDK client with custom auth (e.g., IAM token generation):

```typescript
const clientFactory: DatabaseClientFactory = {
  async createClient(options) {
    const client = new pg.Client({ host: options.hostname, /* ... */ })
    await client.connect()
    return {
      query: (text, values) => client.query(text, values),
      end: () => client.end(),
    }
  },
}
```

## Notes

- Schema is compatible with the SQLite adapter — migrations run the same on both
- Aurora DSQL requires IAM authentication; configure credentials via standard AWS
  environment variables or the credentials chain
