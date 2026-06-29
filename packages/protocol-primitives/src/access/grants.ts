/**
 * Per-app, per-type access-grant model and the predicates that read it.
 *
 * `shared.records` (DSQL) / `shared_records` (SQLite) is one flat table holding
 * every shared type, and DSQL has no row-level security — so neither PG GRANTs
 * nor SQLite alone can scope an app to its own types. Both data servers load the
 * caller app's grant rows and gate reads/writes in application code. This module
 * is the **single** home for that gate: the grant→category derivation and the
 * `can*` predicates live here, and each server supplies only its own grant
 * source (DSQL vs SQLite) and its own all-access policy (which app ids).
 *
 * Pure and store-agnostic — it depends on nothing but the type/category system.
 */

import { typeCategory } from "../types/core-types.js";

export type GrantAccess = "read" | "readwrite";

/** A normalized grant row, as either server reads it from its store. */
export interface AccessGrantRow {
  /** The granted Starkeep type id (`<category>/<format>`). */
  typeId: string;
  access: GrantAccess;
  /**
   * Whether this grant also permits per-category metadata writes. Tracked
   * locally (the SQLite `shared_access_grants.metadata_write` column); the cloud
   * gates metadata writes by writable category and leaves this unset.
   */
  metadataWrite?: boolean;
}

/**
 * A resolved snapshot of one app's grants. `allAccess` is the User-Data-Owner
 * (Starkeep Drive) — and, locally, the watcher — which operate on all shared
 * data (every type plus the Drive-only `other` catch-all) and so cannot be
 * represented as a finite set of grant rows; they are authorized by app id.
 */
export interface AccessGrants {
  readonly readableTypes: ReadonlySet<string>;
  readonly writableTypes: ReadonlySet<string>;
  /**
   * Categories derived from the type grants — a category is readable
   * (resp. writable) when the app can read (resp. write) at least one type that
   * maps to it. Object-storage keys (`shared/<category>/…`), the per-category
   * metadata tables, and the IAM ceiling are all category-namespaced, so those
   * resources authorize at this granularity while record `type` stays the full
   * `<category>/<format>` id.
   */
  readonly readableCategories: ReadonlySet<string>;
  readonly writableCategories: ReadonlySet<string>;
  /** Categories the app may write metadata for (local-only `metadataWrite`). */
  readonly writableMetadataCategories: ReadonlySet<string>;
  /** Unrestricted read/write across all shared data. */
  readonly allAccess: boolean;
}

const EMPTY: ReadonlySet<string> = new Set();

/**
 * Build an {@link AccessGrants} snapshot from a caller's grant rows. When
 * `allAccess` is set the rows are ignored and every `can*` predicate returns
 * true (the sets are left empty; the predicates short-circuit on `allAccess`).
 */
export function buildAccessGrants(
  rows: Iterable<AccessGrantRow>,
  options: { allAccess: boolean },
): AccessGrants {
  if (options.allAccess) {
    return {
      readableTypes: EMPTY,
      writableTypes: EMPTY,
      readableCategories: EMPTY,
      writableCategories: EMPTY,
      writableMetadataCategories: EMPTY,
      allAccess: true,
    };
  }
  const readableTypes = new Set<string>();
  const writableTypes = new Set<string>();
  const readableCategories = new Set<string>();
  const writableCategories = new Set<string>();
  const writableMetadataCategories = new Set<string>();
  for (const row of rows) {
    const category = typeCategory(row.typeId);
    if (row.access === "read" || row.access === "readwrite") {
      readableTypes.add(row.typeId);
      readableCategories.add(category);
    }
    if (row.access === "readwrite") {
      writableTypes.add(row.typeId);
      writableCategories.add(category);
    }
    if (row.metadataWrite) {
      writableMetadataCategories.add(category);
    }
  }
  return {
    readableTypes,
    writableTypes,
    readableCategories,
    writableCategories,
    writableMetadataCategories,
    allAccess: false,
  };
}

/** True if the caller may read records of `type` (the `<category>/<format>` id). */
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
 * metadata table). All-access covers every category, including `other`.
 */
export function canReadCategory(grants: AccessGrants, category: string): boolean {
  return grants.allAccess || grants.readableCategories.has(category);
}

/** True if the caller may write the category-namespaced resources of `category`. */
export function canWriteCategory(grants: AccessGrants, category: string): boolean {
  return grants.allAccess || grants.writableCategories.has(category);
}

/** True if the caller may write per-category metadata for `category`. */
export function canWriteMetadataCategory(grants: AccessGrants, category: string): boolean {
  return grants.allAccess || grants.writableMetadataCategories.has(category);
}
