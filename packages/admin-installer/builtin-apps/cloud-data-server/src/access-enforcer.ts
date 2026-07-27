/**
 * Cloud-side loader for the per-type access gate on `shared.records`.
 *
 * The grant model and the `can*` predicates live in `@starkeep/protocol-
 * primitives` (`access/grants.ts`) and are shared with the local-data-server —
 * this file supplies only the cloud's grant *source* (the `shared.access_grants`
 * DSQL table) and the cloud's all-access policy (Starkeep Drive by app id). See
 * that module for why an application-layer gate is needed (DSQL has no RLS and
 * `shared.records` is one flat table for every type).
 */

import { buildAccessGrants, type GrantAccess } from "@starkeep/protocol-primitives";
import type { DatabaseClient } from "@starkeep/storage-aurora-dsql";

export type { AccessGrants } from "@starkeep/protocol-primitives";
export {
  canRead,
  canWrite,
  canReadCategory,
  canWriteCategory,
} from "@starkeep/protocol-primitives";
import type { AccessGrants } from "@starkeep/protocol-primitives";
import { postgresCompiler } from "@starkeep/storage-aurora-dsql";

/** The User-Data-Owner app id — granted all-access by id, not by grant rows. */
export const USER_DATA_OWNER_APP_ID = "starkeep-drive";

/**
 * Load the caller app's per-type grants from `shared.access_grants`.
 *
 * Every install (see dsql-ddl.ts) writes one row per declared type, so this
 * query needs no client-side expansion — the rows are concrete type ids. Drive
 * (fileAccessAll) writes no rows and is flagged all-access by app id.
 */
export async function loadAccessGrants(
  client: DatabaseClient,
  appId: string,
): Promise<AccessGrants> {
  if (appId === USER_DATA_OWNER_APP_ID) {
    return buildAccessGrants([], { allAccess: true });
  }
  const grantsQuery = postgresCompiler
    .selectFrom("shared.access_grants")
    .select(["type_id", "access"])
    .where("app_id", "=", appId)
    .compile();
  const result = await client.query(grantsQuery.sql, [...grantsQuery.parameters]);
  const rows = (result.rows as Array<{ type_id: string; access: string }>).map((r) => ({
    typeId: r.type_id,
    access: r.access as GrantAccess,
  }));
  return buildAccessGrants(rows, { allAccess: false });
}

/**
 * Load the label keys the caller's manifest declared, from
 * `shared.app_label_keys`. The label write path rejects anything absent from
 * this set, which is what makes the per-app key-cardinality cap enforceable.
 *
 * A small per-request lookup on a table of tens of rows — the same shape and
 * cost as `loadAccessGrants` above, and loaded alongside it.
 *
 * Note there is no all-access shortcut here, unlike grants. Drive reads
 * everything but writes only its own namespace, and "all access" says nothing
 * about which keys an app declared; an app with no declared keys can write no
 * labels, Drive included.
 */
export async function loadDeclaredLabelKeys(
  client: DatabaseClient,
  appId: string,
): Promise<Set<string>> {
  const query = postgresCompiler
    .selectFrom("shared.app_label_keys")
    .select("key")
    .where("app_id", "=", appId)
    .compile();
  const result = await client.query(query.sql, [...query.parameters]);
  return new Set((result.rows as Array<{ key: string }>).map((r) => r.key));
}
