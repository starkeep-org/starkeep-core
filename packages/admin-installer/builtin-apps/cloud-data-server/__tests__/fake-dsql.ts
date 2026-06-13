/**
 * Scripted DatabaseClientFactory for handler tests. Every SQL statement the
 * handler issues must be matched by a scripted route, otherwise the fake
 * throws with the offending text — unscripted queries are test bugs, not
 * silent empty results.
 */
import { serializeHLC } from "@starkeep/protocol-primitives";
import type {
  AuroraDsqlDatabaseAdapterOptions,
  DatabaseClient,
  DatabaseClientFactory,
} from "@starkeep/storage-aurora-dsql";

export interface LoggedQuery {
  text: string;
  values: unknown[];
}

type Rows = Record<string, unknown>[];

export class FakeDsql implements DatabaseClientFactory {
  readonly log: LoggedQuery[] = [];
  private readonly routes: Array<{ match: RegExp; rows: (q: LoggedQuery) => Rows }> = [];

  on(match: RegExp, rows: Rows | ((q: LoggedQuery) => Rows)): this {
    this.routes.push({ match, rows: typeof rows === "function" ? rows : () => rows });
    return this;
  }

  /** Logged queries whose SQL matches. */
  calls(match: RegExp): LoggedQuery[] {
    return this.log.filter((q) => match.test(q.text));
  }

  async createClient(_options: AuroraDsqlDatabaseAdapterOptions): Promise<DatabaseClient> {
    return {
      query: async (text, values) => {
        const q: LoggedQuery = { text, values: values ?? [] };
        this.log.push(q);
        for (const route of this.routes) {
          if (route.match.test(text)) return { rows: route.rows(q) };
        }
        throw new Error(`FakeDsql: unscripted SQL: ${text}`);
      },
      end: async () => {},
    };
  }
}

/**
 * A fake pre-scripted with the two queries every authenticated request makes:
 * the caller's access_grants rows and the cloud-clock seed scan.
 */
export function fakeDsqlWithGrants(
  grantRows: Array<{ type_id: string; access: string }> = [],
): FakeDsql {
  return new FakeDsql()
    .on(/FROM shared\.access_grants/, grantRows)
    .on(/FROM shared\.records WHERE updated_at LIKE/, []);
}

const TEST_HLC = serializeHLC({ wallTime: Date.UTC(2026, 0, 1), counter: 0, nodeId: "test" });

/** A shared.records row in the adapter's PostgresRow shape. */
export function recordRow(
  partial: { id: string; type: string } & Partial<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    created_at: TEST_HLC,
    updated_at: TEST_HLC,
    deleted_at: null,
    version: 1,
    content_hash: "a".repeat(64),
    object_storage_key: `shared/image/aa/${"a".repeat(64)}`,
    mime_type: "application/octet-stream",
    size_bytes: 3,
    original_filename: null,
    origin_app_id: "some-app",
    parent_id: null,
    ...partial,
  };
}
