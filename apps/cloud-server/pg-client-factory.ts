import pg from "pg";
import type {
  AuroraDsqlDatabaseAdapterOptions,
  DatabaseClient,
  DatabaseClientFactory,
} from "@starkeep/storage-aurora-dsql";

/**
 * DatabaseClientFactory backed by `pg.Pool`. The Aurora DSQL adapter
 * speaks Postgres wire protocol, so a local Postgres instance works as a
 * dev substitute and can be swapped for a real DSQL client later.
 */
export function createPgClientFactory(
  connectionString: string,
): DatabaseClientFactory {
  return {
    async createClient(
      _options: AuroraDsqlDatabaseAdapterOptions,
    ): Promise<DatabaseClient> {
      const pool = new pg.Pool({ connectionString });
      return {
        async query(text, values) {
          const result = await pool.query(text, values as unknown[] | undefined);
          return { rows: result.rows as Record<string, unknown>[] };
        },
        async end() {
          await pool.end();
        },
      };
    },
  };
}
