import { DsqlSigner } from "@aws-sdk/dsql-signer";
import pg from "pg";
import type {
  DatabaseClientFactory,
  DatabaseClient,
  AuroraDsqlDatabaseAdapterOptions,
} from "@starkeep/storage-aurora-dsql";

async function createPgClient(
  options: AuroraDsqlDatabaseAdapterOptions,
): Promise<pg.Client> {
  const signer = new DsqlSigner({
    hostname: options.hostname,
    region: options.region,
  });
  const token = await signer.getDbConnectAdminAuthToken();
  const client = new pg.Client({
    host: options.hostname,
    port: 5432,
    database: options.database ?? "postgres",
    user: "admin",
    password: token,
    ssl: { rejectUnauthorized: true },
  });
  await client.connect();
  return client;
}

export class AuroraDsqlClientFactory implements DatabaseClientFactory {
  async createClient(
    options: AuroraDsqlDatabaseAdapterOptions,
  ): Promise<DatabaseClient> {
    let inner = await createPgClient(options);

    return {
      async query(
        text: string,
        values?: unknown[],
      ): Promise<{ rows: Record<string, unknown>[] }> {
        try {
          const result = await inner.query(text, values);
          return { rows: result.rows };
        } catch (err: unknown) {
          // IAM auth token expired (~15 min) — reconnect with a fresh token and retry once
          const code = (err as { code?: string })?.code;
          if (code === "28000" || code === "28P01") {
            await inner.end().catch(() => {});
            inner = await createPgClient(options);
            const result = await inner.query(text, values);
            return { rows: result.rows };
          }
          throw err;
        }
      },
      async end(): Promise<void> {
        await inner.end();
      },
    };
  }
}
