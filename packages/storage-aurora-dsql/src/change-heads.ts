/**
 * One change token per user per sync channel, replaced by every write to the
 * channel's synced tables in the write's own transaction.
 *
 * An idle sync exchange used to read every watermark the channel has to learn
 * that nothing had changed. With the token, a requester that echoes the token
 * it last saw is answered "unchanged" from one primary-key read. See
 * `@starkeep/sync-engine`, `SyncExchangeRequest.changeToken`.
 *
 * ## Why a write cannot slip past a token
 *
 * Every writer replaces the same row, so DSQL's optimistic concurrency orders
 * the writers: of two transactions that both replace it, the second to commit
 * aborts with 40001 and retries. The responder reads the token before it reads
 * any data. A write that commits before that data read is in the reply; one
 * that commits after it also replaced the token after the responder read it,
 * so the token the requester holds is already stale. No clock is involved, so
 * clock drift between Lambdas cannot reorder anything.
 *
 * The token is random rather than a counter: restoring a backup rewinds a
 * counter, and the values reissued after it would name different data.
 *
 * ## Who writes it
 *
 * Only the cloud data server issues SQL, under the per-app role of the request
 * (`data-roles-and-permissions.md`, "How data access actually flows at
 * runtime"), so no app can reach this table. What remains is a bug in the
 * server, and {@link guardChangeHeads} bounds that: the one statement that may
 * write a head is {@link buildChangeHeadReplace}, whose value the database
 * generates, and no transaction that writes a synced table may commit without
 * replacing that table's channel's head.
 */

import { sql, type CompiledQuery } from "kysely";
import { BYTE_COVERAGE_TABLE } from "@starkeep/shared-space-api";
import { ownerScopedCompiler, type PostgresCompiler } from "./query-builder.js";
import type { DatabaseClient } from "./types.js";

export const CHANGE_HEADS_TABLE = "shared.change_heads";

/** The channel the shared tables belong to: Starkeep Drive's. */
export const SHARED_CHANNEL = "shared";

/**
 * The channel an app's own tables belong to, named by their schema so the
 * write guard can read it straight off a statement.
 */
export function appChannel(appId: string): string {
  return `app_${appId.replace(/-/g, "_")}`;
}

/**
 * Replace a channel's token with a fresh one. The value comes from the
 * database, never from the caller, so no code path can choose it.
 */
export function buildChangeHeadReplace(qb: PostgresCompiler, channel: string): CompiledQuery {
  return qb
    .insertInto(CHANGE_HEADS_TABLE)
    .values({ channel, token: sql`gen_random_uuid()::text` })
    .onConflict((oc) =>
      oc.column("channel").doUpdateSet((eb) => ({ token: eb.ref("excluded.token") })),
    )
    .compile();
}

/** A channel's current token, or `null` before its first write. */
export async function readChangeHead(
  client: DatabaseClient,
  qb: PostgresCompiler,
  channel: string,
): Promise<string | null> {
  const q = qb
    .selectFrom(CHANGE_HEADS_TABLE)
    .select("token")
    .where("channel", "=", channel)
    .compile();
  const { rows } = await client.query(q.sql, [...q.parameters]);
  const token = rows[0]?.["token"];
  return typeof token === "string" ? token : null;
}

/**
 * The replacement as the guard expects to see it. The owner and type scopes
 * add the owner to an insert and nothing else, so every compiler the server
 * uses produces this text.
 */
const CHANNEL_SENTINEL = "\u0000channel";
const CANONICAL = buildChangeHeadReplace(ownerScopedCompiler("canonical"), CHANNEL_SENTINEL);
const CHANNEL_PARAM = CANONICAL.parameters.indexOf(CHANNEL_SENTINEL);

const WRITE = /^\s*(?:insert\s+into|update|delete\s+from)\s+"?([a-z0-9_]+)"?\."?([a-z0-9_]+)"?/i;
const SYNCED_SHARED_TABLE = /^(?:records|record_labels|record_[a-z0-9_]+_metadata)$/;
const NAMES_CHANGE_HEADS = /"?shared"?\."?change_heads"?/i;

/** The channel a write to `schema.table` changes, or `null` for a table no exchange carries. */
function channelOf(schema: string, table: string): string | null {
  if (schema === "shared") return SYNCED_SHARED_TABLE.test(table) ? SHARED_CHANNEL : null;
  if (schema.startsWith("app_")) return table === BYTE_COVERAGE_TABLE ? null : schema;
  return null;
}

const GUARDED = Symbol("guardChangeHeads");

/**
 * A client that refuses writes the change tokens would not see.
 *
 * - A write to a synced table outside `BEGIN … COMMIT` is refused before it
 *   runs: nothing could replace its channel's head in the same transaction.
 * - A `COMMIT` is refused, and the transaction rolled back, when the
 *   transaction wrote a synced table without replacing that table's channel's
 *   head.
 * - Any statement that writes `shared.change_heads` other than
 *   {@link buildChangeHeadReplace} is refused, so a bug cannot set a head to a
 *   value a requester already holds.
 *
 * The state is per client, which is per connection, which is what a
 * transaction is. Wrapping a guarded client again returns it unchanged.
 */
export function guardChangeHeads(client: DatabaseClient): DatabaseClient {
  if ((client as { [GUARDED]?: true })[GUARDED]) return client;
  let inTransaction = false;
  const written = new Set<string>();
  const replaced = new Set<string>();
  const reset = () => {
    inTransaction = false;
    written.clear();
    replaced.clear();
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
        const missing = [...written].filter((channel) => !replaced.has(channel));
        if (missing.length > 0) {
          reset();
          await client.query("ROLLBACK");
          throw new Error(
            `refused COMMIT: the transaction wrote channel(s) ${missing.join(", ")} without replacing their change head`,
          );
        }
        reset();
        return client.query(text, values);
      }
      if (/^\s*rollback\s*;?\s*$/i.test(text)) {
        reset();
        return client.query(text, values);
      }

      if (NAMES_CHANGE_HEADS.test(text) && !/^\s*select\b/i.test(text)) {
        if (text !== CANONICAL.sql) {
          throw new Error(`refused a write to the change heads: ${text.slice(0, 200)}`);
        }
        if (inTransaction) replaced.add(String(values?.[CHANNEL_PARAM]));
        return client.query(text, values);
      }

      const write = WRITE.exec(text);
      const channel = write ? channelOf(write[1]!.toLowerCase(), write[2]!.toLowerCase()) : null;
      if (channel !== null) {
        if (!inTransaction) {
          throw new Error(
            `refused a write to a synced table outside a transaction, where nothing replaces channel ${channel}'s change head: ${text.slice(0, 200)}`,
          );
        }
        written.add(channel);
      }
      return client.query(text, values);
    },
    end: () => client.end(),
  };
  return guarded;
}
