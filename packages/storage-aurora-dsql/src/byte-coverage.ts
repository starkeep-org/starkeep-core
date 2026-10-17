/**
 * The cloud's own bytes watermark for one sync channel, stored in that
 * channel's app schema.
 *
 * A bytes watermark says, per author, "every file this node wants, from rows
 * by that author up to here, is in its storage". The cloud reports its own on
 * every exchange, so a phone knows which uploads it still owes. Recomputing it
 * would mean checking every file an author ever wrote, so the cloud stores the
 * value and walks forward from it. See `@starkeep/sync-engine`,
 * `SyncExchangeResponse.responderByteWatermarks`.
 *
 * One table per channel, in the channel's own schema (`app_<appId>`), so the
 * per-app database roles that already confine each channel confine this too:
 * no app can read or move another channel's value. The installer creates it
 * beside the app's other reserved tables (`dsql-ddl.ts`). The Drive channel is
 * installed as an app and gets one the same way.
 */

import { deserializeHLC, serializeHLC, type HLCTimestamp } from "@starkeep/protocol-primitives";
import type { DatabaseClient } from "./types.js";
import { ownerScopedCompiler } from "./query-builder.js";
import { withOccRetry } from "./occ-retry.js";
import { BYTE_COVERAGE_TABLE } from "@starkeep/shared-space-api";

export { BYTE_COVERAGE_TABLE };

/** The schema a channel's tables live in. */
export function appSchemaName(appId: string): string {
  return `app_${appId.replace(/-/g, "_")}`;
}

export interface DsqlByteCoverageStore {
  load(): Promise<Record<string, HLCTimestamp>>;
  save(watermarks: Record<string, HLCTimestamp>): Promise<void>;
}

/**
 * A store over `app_<appId>._starkeep_byte_coverage`.
 *
 * `load` lets a missing table throw. A channel installed before the table
 * existed then reports no bytes watermark, and requesters stop pushing until
 * the app is reinstalled — loudly, rather than walking every file from the
 * beginning on every exchange.
 *
 * `save` upserts every entry. An author absent from the map keeps its row;
 * the sync engine lowers a stored value to the rows it still holds on every
 * load, so a stale row cannot claim files.
 */
export function createDsqlByteCoverageStore(
  client: DatabaseClient,
  appId: string,
  /** The user whose watermark this is: each user's library is covered apart. */
  ownerId: string,
): DsqlByteCoverageStore {
  const table = `${appSchemaName(appId)}.${BYTE_COVERAGE_TABLE}`;
  const qb = ownerScopedCompiler(ownerId);
  return {
    async load() {
      const compiled = qb.selectFrom(table).select(["node_id", "hlc"]).compile();
      const result = await client.query(compiled.sql, [...compiled.parameters]);
      const out: Record<string, HLCTimestamp> = {};
      for (const row of result.rows) {
        out[String(row["node_id"])] = deserializeHLC(String(row["hlc"]));
      }
      return out;
    },
    async save(watermarks) {
      const entries = Object.entries(watermarks);
      if (entries.length === 0) return;
      await withOccRetry("byteCoverage.save", async () => {
        const compiled = qb
          .insertInto(table)
          .values(entries.map(([nodeId, hlc]) => ({ node_id: nodeId, hlc: serializeHLC(hlc) })))
          .onConflict((oc) => oc.column("node_id").doUpdateSet((eb) => ({ hlc: eb.ref("excluded.hlc") })))
          .compile();
        await client.query(compiled.sql, [...compiled.parameters]);
      });
    },
  };
}
