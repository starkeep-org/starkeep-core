/**
 * Per-author watermarks for the cloud's synced tables, kept in tables of their
 * own and raised by every write.
 *
 * A sync responder reports its coverage, per author, the highest stamp it
 * holds, and plans its delta scans from the same map. Computing that map with
 * a grouped read over the rows reads every row the user owns in the table,
 * and DSQL bills by rows read, so an idle tick paid for the whole library.
 * These tables hold the answer instead, one row per user, author and type or
 * table:
 *
 * | Table                                | Key                               | Source table           |
 * | ------------------------------------ | --------------------------------- | ---------------------- |
 * | `shared.node_watermarks_records`     | `(user_id, type, node_id)`        | `shared.records`       |
 * | `shared.node_watermarks_labels`      | `(user_id, record_type, node_id)` | `shared.record_labels` |
 * | `app_<id>._starkeep_node_watermarks` | `(user_id, table_name, node_id)`  | each synced app table  |
 *
 * Each entry is the highest `updated_at` among the rows that have landed in
 * its source table for that key. It never decreases, so it can exceed every
 * row the cloud still holds from an author whose rows were all superseded.
 * The protocol allows that: coverage says "everything from this author up to
 * here has reached me", and it had.
 *
 * ## The write rule
 *
 * Every write to a synced table raises its authors' entries inside the
 * write's own transaction, with {@link buildWatermarkRaises}. The raise takes
 * its value from the source table, never from a parameter: it selects the
 * rows the transaction just wrote, by author and stamp, and folds their
 * maximum in. A write that lost last-writer-wins wrote no row with its stamp,
 * so it records nothing. {@link guardNodeWatermarks} refuses a commit that
 * skipped a raise, and any other write to these tables.
 *
 * ## Hard deletes
 *
 * Only two paths delete synced rows outright, and both take the entries with
 * them: uninstall drops the app's schema, and `clear-user-cloud-data.ts`
 * deletes every owned table's rows for the user. A new hard delete of a synced
 * row must clear the matching entries too. Otherwise the cloud would report
 * coverage it no longer has, and requesters would stop pushing those rows.
 *
 * See `~/projects/starkeep/plan-dsql-node-watermark-table-2026-10-30.md`.
 */

import { sql, type CompiledQuery } from "kysely";
import { deserializeHLC, serializeHLC, type HLCTimestamp } from "@starkeep/protocol-primitives";
import { BYTE_COVERAGE_TABLE, NODE_WATERMARKS_TABLE } from "@starkeep/shared-space-api";
import { appSchemaName } from "./byte-coverage.js";
import { OWNER_COLUMN } from "./owner-scope.js";
import { ownerScopedCompiler, type PostgresCompiler } from "./query-builder.js";
import type { DatabaseClient } from "./types.js";

export { NODE_WATERMARKS_TABLE };

export const RECORD_WATERMARKS_TABLE = "shared.node_watermarks_records";
export const LABEL_WATERMARKS_TABLE = "shared.node_watermarks_labels";

/** A synced table whose writes raise watermark entries. */
export type WatermarkSource =
  | { readonly kind: "records" }
  | { readonly kind: "labels" }
  | { readonly kind: "app"; readonly schema: string; readonly table: string };

export const RECORDS_SOURCE = { kind: "records" } as const satisfies WatermarkSource;
export const LABELS_SOURCE = { kind: "labels" } as const satisfies WatermarkSource;

/** A synced table in an app's schema. */
export function appSource(appId: string, table: string): WatermarkSource {
  return { kind: "app", schema: appSchemaName(appId), table };
}

/** One row a write landed: its author and its serialized stamp. */
export interface WrittenStamp {
  readonly nodeId: string;
  readonly stamp: string;
}

/** The stamp a write with `hlc` lands. */
export function writtenStamp(hlc: HLCTimestamp): WrittenStamp {
  return { nodeId: hlc.nodeId, stamp: serializeHLC(hlc) };
}

/** Where a source's rows live, where its entries live, and the column that keys them. */
function layout(source: WatermarkSource): {
  readonly rows: string;
  readonly entries: string;
  readonly keyColumn: "type" | "record_type" | "table_name";
} {
  switch (source.kind) {
    case "records":
      return { rows: "shared.records", entries: RECORD_WATERMARKS_TABLE, keyColumn: "type" };
    case "labels":
      return {
        rows: "shared.record_labels",
        entries: LABEL_WATERMARKS_TABLE,
        keyColumn: "record_type",
      };
    case "app":
      return {
        rows: `${source.schema}.${source.table}`,
        entries: `${source.schema}.${NODE_WATERMARKS_TABLE}`,
        keyColumn: "table_name",
      };
  }
}

/**
 * Raise one author's entries from the rows with `stamps`: the canonical
 * raise, and the only write {@link guardNodeWatermarks} lets through.
 *
 * Compile it with an owner-scoped compiler, never a type-scoped one: the
 * raise has to see every row the transaction wrote, and the guard compares
 * its text against the owner-scoped form.
 */
export function buildWatermarkRaise(
  qb: PostgresCompiler,
  source: WatermarkSource,
  nodeId: string,
  stamps: readonly string[],
): CompiledQuery {
  if (stamps.length === 0) throw new Error("a watermark raise needs at least one stamp");
  const { rows, entries, keyColumn } = layout(source);
  // An app table's entries name the table as a literal, so the statement's
  // text alone says which table it raises; see the guard.
  const key =
    source.kind === "app"
      ? sql<string>`${sql.lit(source.table)}`.as("table_name")
      : sql.ref<string>(keyColumn).as(keyColumn);
  return qb
    .insertInto(entries)
    .columns([OWNER_COLUMN, keyColumn, "node_id", "updated_at"])
    .expression((eb) => {
      let select = eb
        .selectFrom(rows)
        .select(({ fn }) => [
          OWNER_COLUMN,
          key,
          "node_id",
          fn.max<string>("updated_at").as("updated_at"),
        ])
        .where("node_id", "=", nodeId)
        .where("updated_at", "in", [...stamps])
        .groupBy([OWNER_COLUMN, "node_id"]);
      if (source.kind !== "app") select = select.groupBy(keyColumn);
      return select;
    })
    .onConflict((oc) =>
      oc
        .columns([OWNER_COLUMN, keyColumn, "node_id"])
        .doUpdateSet((eb) => ({ updated_at: eb.ref("excluded.updated_at") }))
        .where(sql.ref("excluded.updated_at"), ">", sql.ref(`${entries}.updated_at`)),
    )
    .compile();
}

/**
 * The raises for everything a transaction wrote to one source table: one
 * statement per author, in author order.
 */
export function buildWatermarkRaises(
  qb: PostgresCompiler,
  source: WatermarkSource,
  written: Iterable<WrittenStamp>,
): CompiledQuery[] {
  const byAuthor = new Map<string, Set<string>>();
  for (const { nodeId, stamp } of written) {
    const stamps = byAuthor.get(nodeId) ?? new Set<string>();
    stamps.add(stamp);
    byAuthor.set(nodeId, stamps);
  }
  return [...byAuthor.keys()]
    .sort()
    .map((nodeId) => buildWatermarkRaise(qb, source, nodeId, [...byAuthor.get(nodeId)!].sort()));
}

/**
 * One user's per-author coverage of `shared.records` or
 * `shared.record_labels`. One statement; a type-scoped compiler narrows it to
 * the scope's types. Reads one row per type and author.
 */
export async function readSharedWatermarks(
  client: DatabaseClient,
  qb: PostgresCompiler,
  source: typeof RECORDS_SOURCE | typeof LABELS_SOURCE,
): Promise<Record<string, HLCTimestamp>> {
  const q = qb
    .selectFrom(layout(source).entries)
    .select(({ fn }) => ["node_id", fn.max<string>("updated_at").as("max_updated_at")])
    .groupBy("node_id")
    .compile();
  const { rows } = await client.query(q.sql, [...q.parameters]);
  const out: Record<string, HLCTimestamp> = {};
  for (const row of rows)
    out[String(row["node_id"])] = deserializeHLC(String(row["max_updated_at"]));
  return out;
}

/**
 * One user's per-author coverage of every synced table on an app's channel,
 * by table, in one statement. Lets a missing table throw; the caller decides
 * what a missing table means.
 */
export async function readAppWatermarks(
  client: DatabaseClient,
  qb: PostgresCompiler,
  appId: string,
): Promise<Map<string, Record<string, HLCTimestamp>>> {
  const q = qb
    .selectFrom(`${appSchemaName(appId)}.${NODE_WATERMARKS_TABLE}`)
    .select(["table_name", "node_id", "updated_at"])
    .compile();
  const { rows } = await client.query(q.sql, [...q.parameters]);
  const out = new Map<string, Record<string, HLCTimestamp>>();
  for (const row of rows) {
    const table = String(row["table_name"]);
    const entries = out.get(table) ?? {};
    entries[String(row["node_id"])] = deserializeHLC(String(row["updated_at"]));
    out.set(table, entries);
  }
  return out;
}

// ---- The guard -------------------------------------------------------------

/** A write's target, `schema` and `table`, quoted or not. */
const WRITE =
  /^\s*(?:insert\s+into|update|delete\s+from)\s+"?([A-Za-z0-9_]+)"?\."?([A-Za-z0-9_]+)"?/i;
/** The source a canonical raise selects from. */
const RAISE_SOURCE = /\bfrom "([A-Za-z0-9_]+)"\."([A-Za-z0-9_]+)" where /;
const NAMES_WATERMARKS = new RegExp(
  `"?shared"?\\."?node_watermarks_(?:records|labels)"?|"?app_[A-Za-z0-9_]+"?\\."?${NODE_WATERMARKS_TABLE}"?`,
);

/** The app tables that are a node's own bookkeeping and never sync. */
const UNSYNCED_APP_TABLES = new Set([BYTE_COVERAGE_TABLE, NODE_WATERMARKS_TABLE]);

/**
 * The source `schema.table` names, when writes to it must raise entries:
 * records, labels, and every synced table in an app's schema.
 */
function sourceOf(schema: string, table: string): WatermarkSource | null {
  if (schema === "shared") {
    if (table === "records") return RECORDS_SOURCE;
    if (table === "record_labels") return LABELS_SOURCE;
    return null;
  }
  if (!schema.startsWith("app_") || UNSYNCED_APP_TABLES.has(table)) return null;
  return { kind: "app", schema, table };
}

function sourceKey(source: WatermarkSource): string {
  return layout(source).rows;
}

/** A user id the canonical forms are compiled with; the guard ignores its value. */
const CANONICAL_USER = "canonical";
const canonicalQb = ownerScopedCompiler(CANONICAL_USER);

/**
 * Whether `text` with `values` is the canonical raise for some source, and
 * which. The stamps are the only parameters whose count varies, so the
 * canonical text for a statement with this many parameters is fixed.
 */
function canonicalRaiseSource(text: string, values: readonly unknown[]): WatermarkSource | null {
  const named = RAISE_SOURCE.exec(text);
  if (!named) return null;
  const source = sourceOf(named[1]!, named[2]!);
  if (!source) return null;
  const fixed = buildWatermarkRaise(canonicalQb, source, "n", ["s"]).parameters.length - 1;
  const stamps = values.length - fixed;
  if (stamps < 1) return null;
  const canonical = buildWatermarkRaise(
    canonicalQb,
    source,
    "n",
    Array.from({ length: stamps }, (_, i) => `s${i}`),
  );
  return canonical.sql === text ? source : null;
}

const GUARDED = Symbol("guardNodeWatermarks");

/**
 * A client that refuses writes the watermark tables would not see.
 *
 * - A write to a synced table outside `BEGIN … COMMIT` is refused before it
 *   runs: nothing could raise its entries in the same transaction.
 * - A `COMMIT` is refused, and the transaction rolled back, when the
 *   transaction wrote a synced table without raising that table's entries.
 * - Any statement that writes a watermark table other than the canonical
 *   raise ({@link buildWatermarkRaise}) is refused. The raise carries no
 *   watermark value, so checking its form also bounds the value: it can
 *   record only a stamp that a row of the request's user carries.
 * - Savepoints are refused. A `ROLLBACK TO` would undo a raise the guard had
 *   already counted.
 *
 * The state is per client, which is per connection, which is what a
 * transaction is. Wrapping a guarded client again returns it unchanged.
 */
export function guardNodeWatermarks(client: DatabaseClient): DatabaseClient {
  if ((client as { [GUARDED]?: true })[GUARDED]) return client;
  let inTransaction = false;
  const written = new Set<string>();
  const raised = new Set<string>();
  const reset = () => {
    inTransaction = false;
    written.clear();
    raised.clear();
  };

  const guarded: DatabaseClient & { [GUARDED]: true } = {
    [GUARDED]: true,
    async query(text, values) {
      if (/^\s*(?:begin|start\s+transaction)\b/i.test(text)) {
        const result = await client.query(text, values);
        reset();
        inTransaction = true;
        return result;
      }
      if (/^\s*(?:commit|end)\s*;?\s*$/i.test(text)) {
        const missing = [...written].filter((table) => !raised.has(table));
        if (missing.length > 0) {
          reset();
          await client.query("ROLLBACK");
          throw new Error(
            `refused COMMIT: the transaction wrote ${missing.join(", ")} without raising its node watermarks`,
          );
        }
        reset();
        return client.query(text, values);
      }
      if (/^\s*rollback\s*;?\s*$/i.test(text)) {
        reset();
        return client.query(text, values);
      }
      if (/^\s*(?:savepoint|release|rollback\s+to)\b/i.test(text)) {
        throw new Error(`refused a savepoint, which could undo a counted watermark raise: ${text}`);
      }

      if (NAMES_WATERMARKS.test(text) && !/^\s*select\b/i.test(text)) {
        const source = canonicalRaiseSource(text, values ?? []);
        if (!source) {
          throw new Error(`refused a write to the node watermarks: ${text.slice(0, 200)}`);
        }
        if (inTransaction) raised.add(sourceKey(source));
        return client.query(text, values);
      }

      const write = WRITE.exec(text);
      const source = write ? sourceOf(write[1]!, write[2]!) : null;
      if (source !== null) {
        if (!inTransaction) {
          throw new Error(
            `refused a write to a synced table outside a transaction, where nothing raises its node watermarks: ${text.slice(0, 200)}`,
          );
        }
        written.add(sourceKey(source));
      }
      return client.query(text, values);
    },
    end: () => client.end(),
  };
  return guarded;
}
