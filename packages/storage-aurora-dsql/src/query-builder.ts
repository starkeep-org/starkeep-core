import type { Query } from "@starkeep/storage-adapter";
import {
  buildRecordCount,
  buildRecordSelect,
  buildRecordTypeCounts,
  type RecordDialect,
} from "@starkeep/storage-adapter";
import { pgMetadataTableName } from "@starkeep/protocol-primitives";
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from "kysely";
import { OwnerScopePlugin } from "./owner-scope.js";
import { RecordTypeScopePlugin } from "./type-scope.js";

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

/** A compiler the builders below compile with: the plain one, or a user-scoped one. */
export type PostgresCompiler = Kysely<DB>;

/**
 * The compiler for one user's rows: every statement it compiles reads and
 * writes only `userId`'s rows. See `owner-scope.ts`.
 */
export function ownerScopedCompiler(userId: string): PostgresCompiler {
  return compiler.withPlugin(new OwnerScopePlugin(userId));
}

/**
 * The compiler for one user's rows of the given types only: `userId`'s records
 * whose type is in `types`, and the labels on them. See `type-scope.ts`.
 */
export function typeScopedCompiler(userId: string, types: readonly string[]): PostgresCompiler {
  return compiler
    .withPlugin(new RecordTypeScopePlugin(types))
    .withPlugin(new OwnerScopePlugin(userId));
}

export function buildPostgresQuery(
  query: Query,
  qb: PostgresCompiler = compiler,
): BuiltPostgresQuery {
  const compiled = buildRecordSelect(qb, DIALECT, query);
  return { text: compiled.sql, values: [...compiled.parameters] };
}

export function buildPostgresCountQuery(
  query: Query,
  qb: PostgresCompiler = compiler,
): BuiltPostgresQuery {
  const compiled = buildRecordCount(qb, DIALECT, query);
  return { text: compiled.sql, values: [...compiled.parameters] };
}

export function buildPostgresTypeCountsQuery(
  query: Query,
  qb: PostgresCompiler = compiler,
): BuiltPostgresQuery {
  const compiled = buildRecordTypeCounts(qb, DIALECT, query);
  return { text: compiled.sql, values: [...compiled.parameters] };
}
