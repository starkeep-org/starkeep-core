import {
  collectSince,
  mergeDigestBuckets,
  planNodeScans,
  requireKeyedWhere,
  rowToWireEntry,
  DEFAULT_BUCKET_PREFIX_LENGTH,
  type DigestBucket,
} from "@starkeep/storage-adapter";
import {
  compareHLC,
  deserializeHLC,
  serializeHLC,
  type HLCTimestamp,
} from "@starkeep/protocol-primitives";
import type {
  AppSyncableApplier,
  AppSyncableNamespace,
  AppSyncableNamespaceStore,
  AppSyncableRowEntry,
  ScanCapableApplier,
} from "../../src/types.js";

// Mirror of `FILE_RECORDS_TABLE` from `@starkeep/shared-space-api` and
// `sync-engine.ts` — kept in sync by hand because importing across the cycle
// isn't possible.
export const FILE_RECORDS_TABLE = "_starkeep_sync_records";

export interface MockAppRowStore {
  readonly applier: AppSyncableApplier & ScanCapableApplier;
  readonly namespaces: AppSyncableNamespaceStore;
  /**
   * Direct row access for assertions, keyed by `${appId}::${table}::${pk}`.
   *
   * Stored rows, not wire entries — see the note on `makeMockAppSource`. A
   * tombstoned row is still a row here, exactly as it is in SQL, so `.size`
   * counts everything the table holds.
   */
  readonly rows: Map<string, Record<string, unknown>>;
}

export interface TableSpec {
  readonly name: string;
  readonly pkColumns: readonly string[];
}

/**
 * In-memory `AppSyncableApplier` + namespace store for tests.
 *
 * ## It stores rows, not entries
 *
 * The earlier version kept the incoming `AppSyncableRowEntry` in a map keyed by
 * primary key and handed the same entries back out of `scanSince`. That is a
 * different data model from the one every real applier has, and the difference
 * was not cosmetic: an entry-store cannot express a statement whose `WHERE`
 * matches more than one row, so the sync-engine suite could not observe that
 * both SQL appliers turned a single tombstone into a table-wide soft-delete.
 * It also meant a scanned tombstone came back as whatever entry had been
 * applied rather than being *derived from the stored row*, so the missing
 * `where` never appeared on this path at all.
 *
 * So this now models what the SQL appliers model: a table of column maps, with
 * `updated_at`/`deleted_at`/`node_id` columns, LWW applied per row, tombstones
 * as rows, and wire entries derived on scan through the same
 * {@link rowToWireEntry} the real appliers use.
 *
 * It is still a mock — no SQL, no dialects, no OCC. What it is no longer
 * allowed to be is *differently behaved*: `app-syncable-conformance.test.ts`
 * runs the shared contract from `@starkeep/storage-adapter/conformance` against
 * this implementation and against the real SQLite one, so a divergence on any
 * question a caller depends on fails the build.
 */
export function makeMockAppSource(
  appId: string,
  tables: readonly TableSpec[],
): MockAppRowStore {
  const rows = new Map<string, Record<string, unknown>>();
  const ns: AppSyncableNamespace = {
    appId,
    tables: tables.map((t) => ({ name: t.name, pkColumns: [...t.pkColumns] })),
    filesEnabled: tables.some((t) => t.name === FILE_RECORDS_TABLE),
    tableNames: tables.map((t) => t.name),
  };
  const namespaces: AppSyncableNamespaceStore = {
    get: (id) => (id === appId ? ns : null),
    list: () => [ns],
  };

  function pkColumnsFor(table: string): readonly string[] {
    return tables.find((t) => t.name === table)?.pkColumns ?? [];
  }

  function keyFor(
    entryAppId: string,
    table: string,
    source: Record<string, unknown>,
  ): string {
    const pkColumns = pkColumnsFor(table);
    const pk =
      pkColumns.length === 0
        ? JSON.stringify(source)
        : pkColumns.map((c) => String(source[c])).join("/");
    return `${entryAppId}::${table}::${pk}`;
  }

  /** Rows of one table, in insertion order. */
  function tableRows(
    scanAppId: string,
    table: string,
  ): Record<string, unknown>[] {
    const prefix = `${scanAppId}::${table}::`;
    const out: Record<string, unknown>[] = [];
    for (const [key, row] of rows) {
      if (key.startsWith(prefix)) out.push(row);
    }
    return out;
  }

  function updatedAtOf(row: Record<string, unknown>): string {
    return String(row["updated_at"] ?? "");
  }

  /**
   * Rows an `UPDATE … WHERE` would match. The mock's whole reason for existing
   * in this shape: a `where` of `{}` matches *everything*, which is what makes
   * the keyless-statement cases meaningful rather than vacuous.
   */
  function matching(
    scanAppId: string,
    table: string,
    where: Record<string, unknown>,
  ): Record<string, unknown>[] {
    const cols = Object.keys(where);
    return tableRows(scanAppId, table).filter((row) =>
      cols.every((c) => row[c] === where[c]),
    );
  }

  const applier: AppSyncableApplier & ScanCapableApplier = {
    async apply(entry) {
      const ns_ = namespaces.get(entry.appId);
      if (!ns_) throw new Error(`mock applier: app "${entry.appId}" not installed`);
      if (!ns_.tables.some((t) => t.name === entry.table)) {
        throw new Error(
          `mock applier: table "${entry.table}" not declared for app "${entry.appId}"`,
        );
      }

      if (entry.op === "insert") {
        const incoming = { ...(entry.row ?? {}) };
        if (Object.keys(incoming).length === 0) return;
        if (typeof incoming["updated_at"] !== "string") {
          // The SQL appliers would store NULL here and every scan, watermark
          // and digest reading the column would then misbehave in its own way.
          // Fail loudly instead — a fixture without `updated_at` is a bug.
          throw new Error(
            `mock applier: insert into ${entry.appId}.${entry.table} carries no serialized updated_at`,
          );
        }
        incoming["node_id"] = nodeIdOf(incoming["updated_at"], entry);
        const key = keyFor(entry.appId, entry.table, incoming);
        const existing = rows.get(key);
        // UPSERT … ON CONFLICT DO UPDATE WHERE excluded.updated_at > table.updated_at
        if (existing && updatedAtOf(existing) >= updatedAtOf(incoming)) return;
        rows.set(key, existing ? { ...existing, ...incoming } : incoming);
        return;
      }

      if (entry.op === "update") {
        const where = requireKeyedWhere(entry, "update", pkColumnsFor(entry.table));
        const patch = { ...(entry.row ?? {}) };
        if (Object.keys(patch).length === 0) return;
        if (patch["updated_at"]) {
          patch["node_id"] = nodeIdOf(patch["updated_at"], entry);
        }
        const incomingUpdatedAt = patch["updated_at"] as string | undefined;
        for (const row of matching(entry.appId, entry.table, where)) {
          if (incomingUpdatedAt && updatedAtOf(row) >= incomingUpdatedAt) continue;
          Object.assign(row, patch);
        }
        return;
      }

      const pkColumns = pkColumnsFor(entry.table);
      const where = requireKeyedWhere(entry, "delete", pkColumns);
      const ts =
        (entry.row?.["updated_at"] as string | undefined) ??
        serializeHLC(entry.timestamp);
      const found = matching(entry.appId, entry.table, where);
      if (found.length === 0 && entry.row !== undefined && pkColumns.length > 0) {
        // A tombstone for a row this store never held still has to land, or the
        // two sides count different numbers of rows in the same bucket forever
        // — see `applyDelete` in the SQLite applier for what that costs. The
        // wire form carries the whole row, so there is nothing to invent.
        const materialized: Record<string, unknown> = {
          ...entry.row,
          updated_at: ts,
          deleted_at: ts,
        };
        if (pkColumns.every((c) => materialized[c] !== undefined)) {
          materialized["node_id"] = nodeIdOf(ts, entry);
          rows.set(keyFor(entry.appId, entry.table, materialized), materialized);
          return;
        }
      }
      for (const row of found) {
        if (updatedAtOf(row) >= ts) continue;
        row["deleted_at"] = ts;
        row["updated_at"] = ts;
        row["node_id"] = nodeIdOf(ts, entry);
      }
    },

    // Delta scan through the same `collectSince` the SQL appliers use, so the
    // fair-share split and the truncation marks cannot drift from theirs.
    async scanSince(scanAppId, table, peerWatermarks, limit) {
      if (!namespaces.get(scanAppId)?.tables.some((t) => t.name === table)) {
        return { rows: [], hasMore: false, truncated: {} };
      }
      const byNode = new Map<string, Record<string, unknown>[]>();
      for (const row of tableRows(scanAppId, table)) {
        const nodeId = String(row["node_id"]);
        const bucket = byNode.get(nodeId) ?? [];
        bucket.push(row);
        byNode.set(nodeId, bucket);
      }
      for (const bucket of byNode.values()) {
        bucket.sort((a, b) => updatedAtOf(a).localeCompare(updatedAtOf(b)));
      }

      // `this`, not the closure: both real appliers read their watermarks the
      // same way, and reaching it through `this` is what lets a test replace
      // that one method and see the round react. Outside the try below for the
      // same reason they put it there — a watermark read that failed must not
      // become a scan that found nothing.
      const scans = planNodeScans(
        await this.getNodeWatermarks(scanAppId, table),
        peerWatermarks,
      );
      const page = await collectSince<Record<string, unknown>>(
        scans,
        limit,
        async (scan, remaining) => {
          const bucket = byNode.get(scan.nodeId) ?? [];
          const above =
            scan.since === null
              ? bucket
              : bucket.filter((r) => updatedAtOf(r) > scan.since!);
          // `limit + 1`, matching `buildScanSinceForNode` — the extra row is
          // how `collectSince` tells "that was everything" from "there is more".
          return above.slice(0, remaining + 1);
        },
        (row) => deserializeHLC(updatedAtOf(row)),
      );

      const pkColumns = pkColumnsFor(table);
      return {
        rows: page.rows
          .map((row) => rowToWireEntry(scanAppId, table, row, pkColumns, deserializeHLC))
          .filter((entry): entry is AppSyncableRowEntry => entry !== null),
        hasMore: page.hasMore,
        truncated: page.truncated,
      };
    },

    async bucketDigest(scanAppId, table, prefixLength = DEFAULT_BUCKET_PREFIX_LENGTH) {
      const buckets: DigestBucket[] = [];
      for (const row of tableRows(scanAppId, table)) {
        buckets.push({
          nodeId: String(row["node_id"]),
          bucket: updatedAtOf(row).slice(0, prefixLength),
          count: 1,
        });
      }
      return mergeDigestBuckets(buckets);
    },

    async getNodeWatermarks(scanAppId, table) {
      const out: Record<string, HLCTimestamp> = {};
      for (const row of tableRows(scanAppId, table)) {
        const hlc = deserializeHLC(updatedAtOf(row));
        const existing = out[hlc.nodeId];
        if (!existing || compareHLC(hlc, existing) > 0) out[hlc.nodeId] = hlc;
      }
      return out;
    },
  };

  return { applier, namespaces, rows };
}

/** nodeId from a serialized-HLC `updated_at`, or the entry timestamp's. */
function nodeIdOf(updatedAt: unknown, entry: AppSyncableRowEntry): string {
  if (typeof updatedAt === "string") {
    try {
      return deserializeHLC(updatedAt).nodeId;
    } catch {
      // Not a serialized HLC — fall through to the entry timestamp.
    }
  }
  return entry.timestamp.nodeId;
}
