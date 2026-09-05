import type { Query } from "@starkeep/storage-adapter";
import { buildRecordCount, buildRecordSelect, type RecordDialect } from "@starkeep/storage-adapter";
import { sqliteMetadataTableName } from "@starkeep/protocol-primitives";
import {
  DummyDriver,
  Kysely,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
} from "kysely";

// Single dynamic-schema Kysely instance used only to compile SQL — never
// executes. The DummyDriver lets us reuse Kysely's compiler without pulling
// in a real connection. `any` keeps it dialect-agnostic at the row level;
// column names are validated against the live SQLite schema at runtime.
export type DB = Record<string, Record<string, unknown>>;
export const compiler = new Kysely<DB>({
  dialect: {
    createAdapter: () => new SqliteAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new SqliteIntrospector(db),
    createQueryCompiler: () => new SqliteQueryCompiler(),
  },
});

/**
 * What SQLite calls the tables the shared record queries read.
 *
 * The queries themselves live in `@starkeep/storage-adapter`'s
 * `record-queries.ts`, for the reason stated there: this file and its DSQL twin
 * held two copies of one query and drifted in the ways that mattered.
 */
const DIALECT: RecordDialect = {
  records: "shared_records",
  labels: "shared_record_labels",
  metadataTable: sqliteMetadataTableName,
};

export interface BuiltQuery {
  sql: string;
  params: unknown[];
}

export function buildSelectQuery(query: Query): BuiltQuery {
  const compiled = buildRecordSelect(compiler, DIALECT, query);
  return { sql: compiled.sql, params: [...compiled.parameters] };
}

export function buildCountQuery(query: Query): BuiltQuery {
  const compiled = buildRecordCount(compiler, DIALECT, query);
  return { sql: compiled.sql, params: [...compiled.parameters] };
}
