/**
 * Application-layer per-extension read/write enforcement on `shared.records`.
 *
 * DSQL has no row-level security and `shared.records` is one flat table for
 * every shared type, so PG GRANTs alone cannot scope an app to its own
 * extensions. This helper reads `shared.access_grants` (keyed by extension —
 * `type_id` holds the lowercase extension) for the caller's app and exposes:
 *
 *   - readableTypes:  extensions the caller may SELECT (access ∈ {read, readwrite})
 *   - writableTypes:  extensions the caller may INSERT/UPDATE/DELETE (access='readwrite')
 *   - allAccess:      true for Starkeep Drive (the User-Data-Owner), which
 *                     operates on all shared data — every extension plus the
 *                     Drive-only `other` catch-all. Drive cannot enumerate
 *                     unmapped extensions, so it writes no access_grants rows
 *                     and is authorized by app id instead (mirrors the local
 *                     data-server's all-access check).
 */

import { categoryOf } from "@starkeep/core";
import type { DatabaseClient } from "@starkeep/storage-aurora-dsql";

/** The User-Data-Owner app id — granted all-access by id, not by grant rows. */
export const USER_DATA_OWNER_APP_ID = "starkeep-drive";

export interface AccessGrants {
  readonly appId: string;
  readonly readableTypes: ReadonlySet<string>;
  readonly writableTypes: ReadonlySet<string>;
  /**
   * Categories derived from the extension grants — a category is readable
   * (resp. writable) when the app can read (resp. write) at least one
   * extension that maps to it. Object-storage keys (`shared/<category>/…`) and
   * the per-category metadata tables are category-namespaced, and so is the
   * IAM ceiling, so those resources are authorized at this granularity while
   * the record `type` itself stays extension-keyed.
   */
  readonly readableCategories: ReadonlySet<string>;
  readonly writableCategories: ReadonlySet<string>;
  /** Drive: unrestricted read/write across all shared data. */
  readonly allAccess: boolean;
}

/**
 * Load the caller app's per-extension grants from `shared.access_grants`.
 *
 * Every install (see dsql-ddl.ts) writes one row per declared extension, so
 * this query needs no client-side expansion — the rows are concrete
 * extensions. Drive (fileAccessAll) writes no rows and is flagged all-access
 * by app id.
 */
export async function loadAccessGrants(
  client: DatabaseClient,
  appId: string,
): Promise<AccessGrants> {
  if (appId === USER_DATA_OWNER_APP_ID) {
    return {
      appId,
      readableTypes: new Set(),
      writableTypes: new Set(),
      readableCategories: new Set(),
      writableCategories: new Set(),
      allAccess: true,
    };
  }
  const result = await client.query(
    "SELECT type_id, access FROM shared.access_grants WHERE app_id = $1",
    [appId],
  );
  const readableTypes = new Set<string>();
  const writableTypes = new Set<string>();
  const readableCategories = new Set<string>();
  const writableCategories = new Set<string>();
  for (const row of result.rows as Array<{ type_id: string; access: string }>) {
    const typeId = row.type_id;
    const access = row.access;
    const category = categoryOf(typeId);
    if (access === "read" || access === "readwrite") {
      readableTypes.add(typeId);
      readableCategories.add(category);
    }
    if (access === "readwrite") {
      writableTypes.add(typeId);
      writableCategories.add(category);
    }
  }
  return { appId, readableTypes, writableTypes, readableCategories, writableCategories, allAccess: false };
}

/** True if the caller may read records of `type` (extension). */
export function canRead(grants: AccessGrants, type: string): boolean {
  return grants.allAccess || grants.readableTypes.has(type);
}

/** True if the caller may write (insert/update/delete) records of `type`. */
export function canWrite(grants: AccessGrants, type: string): boolean {
  return grants.allAccess || grants.writableTypes.has(type);
}

/**
 * True if the caller may read the category-namespaced resources of `category`
 * (object-storage blobs under `shared/<category>/…` and the per-category
 * metadata table). Drive (all-access) covers every category, including `other`.
 */
export function canReadCategory(grants: AccessGrants, category: string): boolean {
  return grants.allAccess || grants.readableCategories.has(category);
}

/** True if the caller may write the category-namespaced resources of `category`. */
export function canWriteCategory(grants: AccessGrants, category: string): boolean {
  return grants.allAccess || grants.writableCategories.has(category);
}
