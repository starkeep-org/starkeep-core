/**
 * Application-layer per-type read/write enforcement on `shared.records`.
 *
 * DSQL has no row-level security and `shared.records` is one flat table for
 * every shared type, so PG GRANTs alone cannot scope an app to its own types.
 * This helper reads `shared.access_grants` for the caller's app and exposes:
 *
 *   - readableTypes:  types the caller may SELECT
 *                     (access ∈ {read, readwrite}); excludes `unknown` unless
 *                     the app has canPromoteFromUnknown (access='read').
 *   - writableTypes:  types the caller may INSERT/UPDATE/DELETE
 *                     (access='readwrite'); includes `unknown` if the app has
 *                     canIngestUnknown (access='readwrite' on 'unknown').
 *
 * Asymmetry for the `unknown` holding pen is encoded directly in the
 * access_grants row written at install time (see dsql-ddl.ts):
 *
 *   canIngestUnknown      → access_grants(app, 'unknown', access='readwrite')
 *                           but `unknown` is NOT added to readableTypes
 *   canPromoteFromUnknown → access_grants(app, 'unknown', access='read')
 *                           `unknown` IS in readableTypes; NOT in writableTypes
 *
 * `canIngestUnknown` is stored as 'readwrite' but is treated as write-only:
 * we drop `unknown` from readableTypes unless the grant kind says otherwise.
 * The two flags are mutually exclusive in practice (file-watcher ingests,
 * promotion-app reads); if a hypothetical app sets both, the readable set
 * wins for reads and writability holds for writes — both true at once.
 */

import type { DatabaseClient } from "@starkeep/storage-aurora-dsql";

export interface AccessGrants {
  readonly appId: string;
  readonly readableTypes: ReadonlySet<string>;
  readonly writableTypes: ReadonlySet<string>;
}

/**
 * Load the caller app's per-type grants from `shared.access_grants`.
 *
 * Implementation note: every install (see dsql-ddl.ts) writes one row per
 * granted type, including for wildcard manifests where the installer expands
 * '*' to every non-restricted type. So this query needs no client-side
 * wildcard logic — the rows are already concrete type ids.
 */
export async function loadAccessGrants(
  client: DatabaseClient,
  appId: string,
): Promise<AccessGrants> {
  const result = await client.query(
    "SELECT type_id, access FROM shared.access_grants WHERE app_id = $1",
    [appId],
  );
  const readableTypes = new Set<string>();
  const writableTypes = new Set<string>();
  for (const row of result.rows as Array<{ type_id: string; access: string }>) {
    const typeId = row.type_id;
    const access = row.access;
    if (typeId === "unknown") {
      // Asymmetric: 'read' => promote-from-unknown (SELECT only),
      // 'readwrite' => ingest-unknown (INSERT only). Never both directions.
      if (access === "read") {
        readableTypes.add(typeId);
      } else if (access === "readwrite") {
        writableTypes.add(typeId);
      }
      continue;
    }
    if (access === "read" || access === "readwrite") {
      readableTypes.add(typeId);
    }
    if (access === "readwrite") {
      writableTypes.add(typeId);
    }
  }
  return { appId, readableTypes, writableTypes };
}

/** True if the caller may read records of `type`. */
export function canRead(grants: AccessGrants, type: string): boolean {
  return grants.readableTypes.has(type);
}

/** True if the caller may write (insert/update/delete) records of `type`. */
export function canWrite(grants: AccessGrants, type: string): boolean {
  return grants.writableTypes.has(type);
}
