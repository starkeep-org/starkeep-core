export interface AuroraDsqlDatabaseAdapterOptions {
  readonly hostname: string;
  readonly region: string;
  readonly database?: string;
}

export interface DatabaseClient {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

export interface DatabaseClientFactory {
  createClient(
    options: AuroraDsqlDatabaseAdapterOptions,
  ): Promise<DatabaseClient>;
}
