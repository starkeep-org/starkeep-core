/**
 * Record SQL, built once for both backends.
 *
 * The same argument `label-queries.ts` makes, for the same reason. SQLite and
 * DSQL held two copies of `buildSelectQuery`, identical except for two table
 * names, and the copies were identical in their bugs too: both compiled the
 * pagination cursor as `id > ?` while ordering by something else entirely (see
 * `query-cursor.ts`). Fixing that in two places is how it comes back in one of
 * them.
 *
 * What genuinely differs is the table naming, which is what {@link RecordDialect}
 * carries. Everything else — the filters, the label anti-join, the ordering, the
 * keyset predicate, the page-plus-one paging — is one behaviour that must not
 * differ, so it is written here.
 *
 * ## Ordering is normalized, not passed through
 *
 * A caller's `sort` names fields; this module decides what `ORDER BY` they
 * compile to, and adds two things the caller did not ask for:
 *
 *   1. **An `id` tiebreaker**, because a keyset cursor must name one row and a
 *      sort key does not.
 *   2. **An explicit null position** for every key, because the two backends
 *      disagree about where nulls go and a cursor that means different things
 *      against a local and a cloud data-server is worse than no cursor.
 *
 * Both are spelled out in `query-cursor.ts`.
 */

import type {
  CompiledQuery,
  ExpressionBuilder,
  Kysely,
  RawBuilder,
  SelectQueryBuilder,
} from "kysely";
import type { StarkeepId } from "@starkeep/protocol-primitives";
import { sql } from "kysely";
import type { Query } from "./types.js";
import {
  decodeQueryCursor,
  encodeQueryCursor,
  orderSignature,
  type OrderKey,
  type QueryCursor,
  type QueryCursorKey,
} from "./query-cursor.js";

/** The dynamic (schema-less) row type both adapters' compilers are built on. */
export type RecordDb = Record<string, Record<string, unknown>>;

/** What actually differs between the two backends. */
export interface RecordDialect {
  /** `"shared_records"` (SQLite) or `"shared.records"` (DSQL). */
  records: string;
  /** `"shared_record_labels"` (SQLite) or `"shared.record_labels"` (DSQL). */
  labels: string;
  /**
   * The per-category metadata table, by category id.
   *
   * A function rather than a map because both backends already own one —
   * `sqliteMetadataTableName` and `pgMetadataTableName` — and restating the
   * naming rule here would be a third place for it to drift.
   */
  metadataTable: (category: string) => string;
}

// External (camelCase) → column name (snake_case). Unknown fields pass through,
// which is what lets a caller filter on a column this map has not been taught.
const FIELD_MAP: Record<string, string> = {
  id: "id",
  type: "type",
  createdAt: "created_at",
  updatedAt: "updated_at",
  deletedAt: "deleted_at",
  version: "version",
  contentHash: "content_hash",
  objectStorageKey: "object_storage_key",
  mimeType: "mime_type",
  sizeBytes: "size_bytes",
  originAppId: "origin_app_id",
  parentId: "parent_id",
  originalFilename: "original_filename",
};

function mapField(field: string): string {
  return FIELD_MAP[field] ?? field;
}

/**
 * Ordering keys that are not columns of the records table.
 *
 * `capturedAt` is the only one, and it is a named option rather than a general
 * "sort by any metadata column" mechanism on purpose. Answering the general
 * question means joining a table chosen by a category the query has not
 * necessarily pinned, for a column that may not exist in it — a lot of surface
 * for a question nothing is asking. A photo library ordered by when the shutter
 * fired is the question that is actually being asked.
 *
 * It reads from both the image and the video metadata tables because a library
 * grid holds both, and a record lives in exactly one of them, so the `COALESCE`
 * picks whichever exists without either join multiplying a row: `record_id` is
 * the primary key of both tables.
 *
 * Deliberately **not** coalesced onto `created_at` as a final fallback, even
 * though that is the obvious way to give every record a position. The two are
 * not comparable: `captured_at` is an ISO-8601 string and `created_at` is a
 * serialized HLC, whose leading field is hex wall time. Every ISO string sorts
 * above every HLC string for lexical reasons that have nothing to do with time,
 * so a `COALESCE` of the two would order the library by *whether* a capture time
 * is known rather than by when the picture was taken. A caller that wants the
 * fallback asks for it as a second sort key, and gets a null bucket ordered by
 * import time — which is honest about what it knows.
 */
const VIRTUAL_ORDER_FIELDS = new Set(["capturedAt"]);

/** Is this ordering key one this module has to join a table to answer? */
export function isVirtualOrderField(field: string): boolean {
  return VIRTUAL_ORDER_FIELDS.has(field);
}

/**
 * The ordering a query actually runs under, cursor and all.
 *
 * Exported because the adapters need the same answer twice — once to compile
 * the query, once to cut the cursor off the last row it returned — and deriving
 * it in both places is how the two stop agreeing.
 */
export function orderingFor(query: Query): {
  keys: OrderKey[];
  /** Direction of the trailing `id` tiebreaker. */
  idDirection: "asc" | "desc";
  signature: string;
  /**
   * True when this is the default `id asc` ordering, whose cursor stays a bare
   * record id.
   *
   * The legacy shape is kept rather than migrated, because for that one
   * ordering it is already a correct keyset — `id` is the sole key and the
   * primary key — and because it is what every existing caller of the cloud
   * data-server holds. A cursor is opaque; there is no reason to invalidate the
   * ones in flight to make a wrong shape uniform with a right one.
   */
  bareId: boolean;
} {
  const sort = query.sort ?? [];
  if (sort.length === 0) {
    return { keys: [], idDirection: "asc", signature: "id:asc", bareId: true };
  }
  const keys: OrderKey[] = sort.map((s) => ({
    field: s.field,
    direction: s.direction === "desc" ? "desc" : "asc",
  }));
  // The id follows the last key's direction, so the trailing tiebreaker reads
  // as a continuation of the order rather than a reversal inside it.
  const idDirection = keys[keys.length - 1].direction;
  return {
    keys,
    idDirection,
    signature: orderSignature([...keys, { field: "id", direction: idDirection }]),
    bareId: false,
  };
}

/**
 * How a column is named in the emitted SQL.
 *
 * Qualified only when a join is in play, and that is not a cosmetic choice: an
 * unjoined query has exactly one table, so the qualification adds nothing, and
 * emitting it anyway would rewrite the SQL of every caller that has nothing to
 * do with capture-time ordering. Keeping the common shape byte-identical is
 * what lets this change be about the cursor and nothing else.
 */
function columnRef(dialect: RecordDialect, column: string, qualified: boolean): RawBuilder<unknown> {
  return sql.ref(qualified ? `${dialect.records}.${column}` : column);
}

/** The SQL expression one ordering key compiles to. */
function orderExpression(
  dialect: RecordDialect,
  field: string,
  qualified: boolean,
): RawBuilder<unknown> {
  if (field === "capturedAt") {
    return sql`coalesce(${sql.ref("__om_image.captured_at")}, ${sql.ref("__om_video.captured_at")})`;
  }
  return columnRef(dialect, mapField(field), qualified);
}

/**
 * Does this query need the metadata joins, and therefore qualified names?
 *
 * One question asked once, because the answer decides three things that have to
 * agree: whether to join, whether to qualify, and which `selectAll` to emit.
 */
function needsJoins(keys: readonly OrderKey[]): boolean {
  return keys.some((k) => k.field === "capturedAt");
}

/** The alias a page carries its ordering values back under. See {@link cursorKeysFrom}. */
export function orderValueAlias(index: number): string {
  return `__order_${index}`;
}

/**
 * The builder type every step below threads through.
 *
 * Spelled with a bare `string` table because the table name is the dialect's to
 * choose; Kysely's own inference wants a literal, and the schema type here is
 * dynamic anyway — column names are validated against the live schema at
 * runtime, not by the compiler.
 */
type Qb = SelectQueryBuilder<RecordDb, string, unknown>;

function applyFilters(
  qb: Qb,
  dialect: RecordDialect,
  query: Query,
  qualified: boolean,
): Qb {
  let out = qb;

  if (query.type) {
    out = out.where(columnRef(dialect, "type", qualified), "=", query.type) as Qb;
  }

  for (const filter of query.filters ?? []) {
    const col = columnRef(dialect, mapField(filter.field), qualified);
    switch (filter.operator) {
      case "eq": out = out.where(col, "=", filter.value) as Qb; break;
      case "neq": out = out.where(col, "!=", filter.value) as Qb; break;
      case "gt": out = out.where(col, ">", filter.value) as Qb; break;
      case "gte": out = out.where(col, ">=", filter.value) as Qb; break;
      case "lt": out = out.where(col, "<", filter.value) as Qb; break;
      case "lte": out = out.where(col, "<=", filter.value) as Qb; break;
      case "in": out = out.where(col, "in", filter.value as unknown[]) as Qb; break;
      case "like": out = out.where(col, "like", `%${filter.value}%`) as Qb; break;
      case "isNull": out = out.where(col, "is", null) as Qb; break;
      case "isNotNull": out = out.where(col, "is not", null) as Qb; break;
      default: break;
    }
  }

  if (query.excludeLabel) {
    // NOT EXISTS rather than a LEFT JOIN … IS NULL: a record can carry several
    // values of one key, and a join would multiply its row before the null
    // test, so the record would come back once per *other* label it holds.
    // The tombstone check is not optional — a retracted rendition label means
    // the record is no longer a rendition, and treating the dead row as live
    // would permanently hide it from the grid.
    const { appId, key } = query.excludeLabel;
    out = out.where((eb: ExpressionBuilder<RecordDb, string>) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom(dialect.labels as never)
            .select(sql.ref(`${dialect.labels}.record_id`).as("record_id"))
            .whereRef(
              sql.ref(`${dialect.labels}.record_id`) as never,
              "=",
              columnRef(dialect, "id", true) as never,
            )
            .where(sql.ref(`${dialect.labels}.app_id`), "=", appId)
            .where(sql.ref(`${dialect.labels}.key`), "=", key)
            .where(sql.ref(`${dialect.labels}.deleted_at`), "is", null),
        ),
      ),
    ) as Qb;
  }

  return out;
}

/**
 * Join the metadata tables an ordering key reads from.
 *
 * Only when something asks for them. A grid ordered by `created_at` — every
 * caller before the phone's library — compiles to exactly the SQL it did
 * before, with no joins and no extra selected columns.
 */
function applyOrderJoins(qb: Qb, dialect: RecordDialect, keys: readonly OrderKey[]): Qb {
  if (!keys.some((k) => k.field === "capturedAt")) return qb;
  // Cast through a minimal join signature. Kysely infers a join's shape from a
  // literal table name, and the table here is the dialect's to choose over a
  // schema type that is dynamic by design — so the inference has nothing to
  // work from and collapses. The runtime call is an ordinary `LEFT JOIN`; what
  // the cast gives up is compile-time column checking that this module never
  // had, since `RecordDb` declares no columns.
  const joinable = qb as unknown as {
    leftJoin(table: string, k1: string, k2: string): Qb;
  };
  return joinable
    .leftJoin(`${dialect.metadataTable("image")} as __om_image`, "__om_image.record_id", `${dialect.records}.id`)
    .leftJoin(`${dialect.metadataTable("video")} as __om_video`, "__om_video.record_id", `${dialect.records}.id`);
}

function applyOrderBy(
  qb: Qb,
  dialect: RecordDialect,
  keys: readonly OrderKey[],
  idDirection: "asc" | "desc",
  qualified: boolean,
): Qb {
  let out = qb;
  for (const key of keys) {
    const expr = orderExpression(dialect, key.field, qualified);
    // Nulls last in both dialects, whatever the key's direction. Emitted as a
    // leading boolean rather than as `NULLS LAST`, which SQLite only learned in
    // 3.30 and which the two backends default differently on — see
    // `query-cursor.ts`.
    out = out.orderBy(sql`(${expr} is null)`, "asc") as Qb;
    out = out.orderBy(expr, key.direction) as Qb;
  }
  return out.orderBy(columnRef(dialect, "id", qualified), idDirection) as Qb;
}

/**
 * The keyset predicate: "strictly after the row this cursor names".
 *
 * The expanded lexicographic chain rather than a row-value comparison, because
 * the keys can run in different directions and a null in a row-value comparison
 * evaluates to NULL — which returns an empty page instead of an error, the
 * quietest possible failure.
 *
 *   K1 after
 *   OR (K1 equal AND K2 after)
 *   OR (K1 equal AND K2 equal AND id after)
 */
function applyCursor(
  qb: Qb,
  dialect: RecordDialect,
  keys: readonly OrderKey[],
  idDirection: "asc" | "desc",
  cursor: QueryCursor,
  qualified: boolean,
): Qb {
  return qb.where((eb: ExpressionBuilder<RecordDb, string>) => {
    const after = (index: number) => {
      const key = keys[index];
      const value = cursor.keys[index];
      const expr = orderExpression(dialect, key.field, qualified);
      const op = key.direction === "desc" ? "<" : ">";
      if (value.isNull) {
        // The cursor sits in the null bucket, which sorts last. Nothing is after
        // it on this key; only the id can separate rows inside it.
        return sql<boolean>`0 = 1`;
      }
      // A null on this key is after any value, because nulls sort last.
      return sql<boolean>`(${expr} is null or ${expr} ${sql.raw(op)} ${value.value})`;
    };

    const equal = (index: number) => {
      const key = keys[index];
      const value = cursor.keys[index];
      const expr = orderExpression(dialect, key.field, qualified);
      return value.isNull
        ? sql<boolean>`${expr} is null`
        : sql<boolean>`(${expr} is not null and ${expr} = ${value.value})`;
    };

    const idExpr = columnRef(dialect, "id", qualified);
    const idOp = idDirection === "desc" ? "<" : ">";
    const terms = [];
    for (let i = 0; i < keys.length; i += 1) {
      const prefix = [];
      for (let j = 0; j < i; j += 1) prefix.push(equal(j));
      terms.push(prefix.length === 0 ? after(i) : eb.and([...prefix, after(i)]));
    }
    const allEqual = keys.map((_, i) => equal(i));
    terms.push(
      eb.and([...allEqual, sql<boolean>`${idExpr} ${sql.raw(idOp)} ${cursor.id}`]),
    );
    return eb.or(terms);
  }) as Qb;
}

/**
 * One page of records, plus one row so the caller can tell whether more exist.
 *
 * The extra row is the caller's to slice off; this only asks for it.
 */
export function buildRecordSelect(
  k: Kysely<RecordDb>,
  dialect: RecordDialect,
  query: Query,
): CompiledQuery {
  const ordering = orderingFor(query);
  const qualified = needsJoins(ordering.keys);

  // `selectAll(table)` under a join, plain `selectAll()` without one. The two
  // are equivalent when there is one table, and the plain form is the SQL every
  // existing caller already emits.
  let qb = (qualified
    ? k.selectFrom(dialect.records as never).selectAll(dialect.records as never)
    : k.selectFrom(dialect.records as never).selectAll()) as Qb;

  qb = applyOrderJoins(qb, dialect, ordering.keys);

  // The ordering values ride back with the page, under a reserved alias, so the
  // adapter can cut the next cursor from the last row without re-deriving what
  // `capturedAt` resolved to. `rowToRecord` reads named columns, so the extra
  // ones are inert.
  ordering.keys.forEach((key, index) => {
    qb = qb.select(
      orderExpression(dialect, key.field, qualified).as(orderValueAlias(index)),
    ) as Qb;
  });

  qb = applyFilters(qb, dialect, query, qualified);

  if (query.cursor) {
    if (ordering.bareId) {
      qb = qb.where(columnRef(dialect, "id", qualified), ">", query.cursor) as Qb;
    } else {
      const cursor = decodeQueryCursor(query.cursor, ordering.signature);
      // A token that does not decode, or that was cut against another ordering,
      // is dropped rather than honoured — the caller gets the first page. See
      // `query-cursor.ts` for why that beats both throwing and pretending.
      if (cursor && cursor.keys.length === ordering.keys.length) {
        qb = applyCursor(qb, dialect, ordering.keys, ordering.idDirection, cursor, qualified);
      }
    }
  }

  qb = applyOrderBy(qb, dialect, ordering.keys, ordering.idDirection, qualified);

  if (query.limit) {
    qb = qb.limit(query.limit + 1) as Qb;
  }

  return qb.compile();
}

/**
 * How many records match, without paging through them to find out.
 *
 * Ordering is deliberately absent: a count does not depend on it, and joining
 * the metadata tables to answer `capturedAt` would cost a scan for a number
 * that cannot change. `limit` and `cursor` are ignored for the same reason —
 * a count of "the rest of the page" is not a thing anybody wants.
 */
export function buildRecordCount(
  k: Kysely<RecordDb>,
  dialect: RecordDialect,
  query: Query,
): CompiledQuery {
  let qb = k
    .selectFrom(dialect.records as never)
    .select(sql<number>`count(*)`.as("total")) as Qb;
  qb = applyFilters(qb, dialect, query, false);
  return qb.compile();
}

/**
 * The matching rows tallied by `type` — the type histogram as one `GROUP BY`.
 *
 * Same filters as {@link buildRecordCount}, and absent for the same reasons:
 * ordering cannot change a tally, and `limit`/`cursor` would make it a tally of
 * one page. The caller's grant is already in `query.filters` as `type IN (…)`,
 * so the aggregate runs over exactly the readable rows.
 */
export function buildRecordTypeCounts(
  k: Kysely<RecordDb>,
  dialect: RecordDialect,
  query: Query,
): CompiledQuery {
  let qb = k
    .selectFrom(dialect.records as never)
    .select([
      sql.ref(`${dialect.records}.type`).as("type"),
      sql<number>`count(*)`.as("count"),
      sql<string | null>`max(${sql.ref(`${dialect.records}.updated_at`)})`.as("latest_updated_at"),
    ]) as Qb;
  qb = applyFilters(qb, dialect, query, false);
  return (qb.groupBy(sql.ref(`${dialect.records}.type`)) as Qb).compile();
}

/**
 * The ordering key of one returned row, for the cursor that follows it.
 *
 * Reads the reserved aliases {@link buildRecordSelect} added, so the value a
 * cursor carries is the value the database actually ordered on — not a second
 * computation of it that could disagree.
 */
export function cursorKeysFrom(
  row: Record<string, unknown>,
  keyCount: number,
): QueryCursorKey[] {
  const keys: QueryCursorKey[] = [];
  for (let i = 0; i < keyCount; i += 1) {
    const raw = row[orderValueAlias(i)];
    const value = raw === undefined ? null : (raw as QueryCursorKey["value"]);
    keys.push({ isNull: value === null, value });
  }
  return keys;
}

/**
 * The cursor that follows a page, cut from the last row it handed out.
 *
 * Written here rather than in each adapter because it is the exact counterpart
 * of the predicate above: the two have to agree about the ordering, the null
 * flags and the id tiebreaker, and an adapter that built one of them itself
 * would be free to disagree with the other.
 */
export function nextCursorFrom(query: Query, lastRow: Record<string, unknown>): string {
  const ordering = orderingFor(query);
  const id = lastRow["id"] as StarkeepId;
  if (ordering.bareId) return id;
  return encodeQueryCursor({
    order: ordering.signature,
    keys: cursorKeysFrom(lastRow, ordering.keys.length),
    id,
  });
}
