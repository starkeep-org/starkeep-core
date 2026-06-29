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
  const result = await client.query(
    "SELECT type_id, access FROM shared.access_grants WHERE app_id = $1",
    [appId],
  );
  const rows = (result.rows as Array<{ type_id: string; access: string }>).map((r) => ({
    typeId: r.type_id,
    access: r.access as GrantAccess,
  }));
  return buildAccessGrants(rows, { allAccess: false });
}
