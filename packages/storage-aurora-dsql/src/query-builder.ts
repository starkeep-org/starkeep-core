import type { Query } from "@starkeep/storage-adapter";
import { buildRecordCount, buildRecordSelect, type RecordDialect } from "@starkeep/storage-adapter";
import { pgMetadataTableName } from "@starkeep/protocol-primitives";
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from "kysely";

// Compile-only Kysely instance (DummyDriver never executes). The dialect's
// PostgresQueryCompiler produces `$1`-style placeholders that `pg.Client`
// consumes directly.
export type DB = Record<string, Record<string, unknown>>;
export const compiler = new Kysely<DB>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});

/**
 * What DSQL calls the tables the shared record queries read.
 *
 * The queries themselves live in `@starkeep/storage-adapter`'s
 * `record-queries.ts`. This file and its SQLite twin used to hold two copies of
 * one query, which is how both ended up compiling a pagination cursor that did
 * not match the ordering beside it.
 */
const DIALECT: RecordDialect = {
  records: "shared.records",
  labels: "shared.record_labels",
  metadataTable: pgMetadataTableName,
};

export interface BuiltPostgresQuery {
  text: string;
  values: unknown[];
}

export function buildPostgresQuery(query: Query): BuiltPostgresQuery {
  const compiled = buildRecordSelect(compiler, DIALECT, query);
  return { text: compiled.sql, values: [...compiled.parameters] };
}

export function buildPostgresCountQuery(query: Query): BuiltPostgresQuery {
  const compiled = buildRecordCount(compiler, DIALECT, query);
  return { text: compiled.sql, values: [...compiled.parameters] };
}
