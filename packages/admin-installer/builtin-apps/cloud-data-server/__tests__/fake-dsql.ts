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
 * A fake pre-scripted with the queries every authenticated request makes: the
 * caller's access_grants rows and the cloud-clock seed scan.
 *
 * The two label routes are here rather than per-test because the **sync
 * exchange** scans `record_labels` on every Drive-channel round — labels ride
 * that channel alongside records — so any test that touches /sync/exchange
 * needs them whether or not it is about labels.
 *
 * Both are scoped to the *sync* shapes specifically (the full-table scan
 * ordered by primary key, and the watermark fold). Routes match in
 * registration order, first match wins, so a broader pattern here would
 * shadow the `.on(...)` a label test registers for hydration or the reverse
 * query — which is exactly what it did on the first attempt.
 */
export function fakeDsqlWithGrants(
  grantRows: Array<{ type_id: string; access: string }> = [],
  /**
   * Stored availability rows, if the test needs any.
   *
   * A parameter rather than a `.on(...)` a test adds afterwards, because routes
   * match in **registration order** and this helper registers first — a default
   * here would shadow any per-test override, which is the trap this file
   * already warns about for the label routes. Passing them in is the only way
   * to both default the common case (no rows: everything reads as instant) and
   * let a test say otherwise.
   */
  availabilityRows: Rows = [],
  /**
   * Rows the record-level dedup lookup should find, if the test needs any.
   *
   * A parameter for the same reason as `availabilityRows`: routes match in
   * registration order and this helper registers first, so a default here
   * would shadow any per-test `.on(...)` — and the dedup query's SQL is also
   * matched by the broad `select * from "shared"."records"` pattern most
   * registration tests use, which makes the shadowing silent rather than loud.
   */
  dedupRows: Rows = [],
): FakeDsql {
  return new FakeDsql()
    .on(/from "shared"\."access_grants"/, grantRows)
    // Every record listing now reads availability in one batched query. Empty
    // by default: no stored row means the default (instant), which is the
    // ordinary state of an object nothing has moved.
    //
    // Scoped to the select-*-by-key shape specifically. A looser pattern would
    // also swallow the restore rate limit's aggregate below and hand it a row
    // list where it expects a count — which would "work" by accident, since the
    // missing column reads as zero.
    .on(/select \* from "shared"\."object_availability"/, availabilityRows)
    // The restore rate limit's in-flight aggregate. No rows = nothing in
    // flight, which is what every test that isn't about the limit wants.
    .on(/count\(.*\) .*from "shared"\."object_availability"/, [])
    // Issuing a restore records the new state.
    .on(/insert into "shared"\."object_availability"/, [])
    .on(/from "shared"\."records" where "updated_at" like/, [])
    // Record-level dedup runs on every registration now, not just for
    // children. Empty by default: no existing record for these bytes, which is
    // the ordinary case. Tests that exercise dedup override it.
    .on(/from "shared"\."records" where "content_hash" =/, dedupRows)
    .on(/from "shared"\."record_labels" order by "record_id"/, [])
    .on(/from "shared"\."record_labels" group by "node_id"/, [])
    // DELETE /data/records/:id cascades to labels on every record delete,
    // since DSQL has no foreign keys to do it. Returns no rows; tests that
    // assert on the cascade read `db.calls(...)`, which logs every statement
    // regardless of which route answered it.
    .on(/update "shared"\."record_labels" set "deleted_at"/, []);
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
