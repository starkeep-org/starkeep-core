/**
 * The stand-in backlog: originals that are waiting on an app.
 *
 * Two lists, and neither asks the platform to do anything. Apps read them to
 * find work — "which of my photos need a canonical stand-in" — and admin-web
 * reads them to explain why storage costs have not dropped.
 *
 * - `missing-canonical`: originals that take a canonical stand-in and have no
 *   live one. On the cloud that means none in the cloud; on a node it means
 *   no record of one, since a node cannot see the cloud's bytes.
 * - `missing-fidelity`: originals in a stand-in category nobody has reported a
 *   fidelity for. They never archive, and no app can make a stand-in for one
 *   without first reporting the value.
 *
 * ## Short pages are expected
 *
 * "Has no live canonical child" is an anti-join the record query does not
 * express, so a page of candidate originals is cut first and the ones that
 * already have a canonical stand-in drop out afterwards. A page can therefore
 * come back short, or empty, with a cursor — the contract every other filtered
 * page on this route already has: page until the cursor is null.
 */

import {
  TYPES,
  canRead,
  isStandInCategory,
  originalStatus,
  takesCanonical,
  typeCategory,
  type AccessGrants,
  type DataRecord,
  type StandInStandards,
} from "@starkeep/protocol-primitives";
import type { DatabaseAdapter, Filter } from "@starkeep/storage-adapter";

export type BacklogKind = "missing-canonical" | "missing-fidelity";

export const BACKLOG_KINDS: readonly BacklogKind[] = [
  "missing-canonical",
  "missing-fidelity",
];

export interface BacklogPage {
  readonly records: readonly DataRecord[];
  readonly nextCursor: string | null;
}

const MAX_BACKLOG_LIMIT = 500;

/** Every type in a stand-in category the caller may read. */
export function readableStandInTypes(grants: AccessGrants): string[] {
  return TYPES.map((t) => t.id)
    .filter((id) => isStandInCategory(typeCategory(id)))
    .filter((id) => grants.allAccess || canRead(grants, id))
    .sort();
}

export async function pageBacklog(
  db: DatabaseAdapter,
  grants: AccessGrants,
  request: { readonly kind: BacklogKind; readonly limit?: number; readonly cursor?: string },
  standards: StandInStandards,
): Promise<BacklogPage> {
  const types = readableStandInTypes(grants);
  if (types.length === 0) return { records: [], nextCursor: null };
  const limit = Math.min(Math.max(request.limit ?? 100, 1), MAX_BACKLOG_LIMIT);

  const filters: Filter[] = [
    { field: "type", operator: "in", value: types },
    { field: "parentId", operator: "isNull" },
    { field: "standInRole", operator: "isNull" },
    { field: "deletedAt", operator: "isNull" },
    request.kind === "missing-fidelity"
      ? { field: "fidelity", operator: "isNull" }
      : { field: "fidelity", operator: "isNotNull" },
  ];
  const page = await db.query({
    filters,
    limit,
    ...(request.cursor ? { cursor: request.cursor } : {}),
  });
  if (request.kind === "missing-fidelity") {
    return { records: page.records, nextCursor: page.hasMore ? page.nextCursor : null };
  }

  const candidates = page.records.filter((r) => takesCanonical(originalStatus(r, standards)));
  const canonicalOf = new Map<string, DataRecord>();
  if (candidates.length > 0) {
    const canonicals = await db.query({
      filters: [
        { field: "parentId", operator: "in", value: candidates.map((r) => r.id) },
        { field: "standInRole", operator: "eq", value: "canonical" },
        { field: "deletedAt", operator: "isNull" },
      ],
      limit: candidates.length,
    });
    for (const c of canonicals.records) if (c.parentId) canonicalOf.set(c.parentId, c);
  }
  const records = candidates.filter((r) => !canonicalOf.has(r.id));
  return { records, nextCursor: page.hasMore ? page.nextCursor : null };
}

/** A backlog's size, for an operator page. */
export interface BacklogCount {
  readonly count: number;
  /** False when the walk stopped at its limit, so `count` is a lower bound. */
  readonly complete: boolean;
}

/**
 * How many originals are in one backlog, walking at most `maxScanned` of them.
 *
 * `missing-fidelity` is a plain filter and costs one count. `missing-canonical`
 * compares each original with its canonical stand-in, which a count cannot
 * express, so the pages are walked, and the walk is bounded: admin-web asks on
 * every page load, and a large library answers with a lower bound rather than
 * a long wait.
 */
export async function countBacklog(
  db: DatabaseAdapter,
  grants: AccessGrants,
  kind: BacklogKind,
  standards: StandInStandards,
  options: { readonly maxScanned?: number; readonly pageSize?: number } = {},
): Promise<BacklogCount> {
  const types = readableStandInTypes(grants);
  if (types.length === 0) return { count: 0, complete: true };
  if (kind === "missing-fidelity") {
    const count = await db.countRecords({
      filters: [
        { field: "type", operator: "in", value: types },
        { field: "parentId", operator: "isNull" },
        { field: "standInRole", operator: "isNull" },
        { field: "deletedAt", operator: "isNull" },
        { field: "fidelity", operator: "isNull" },
      ],
    });
    return { count, complete: true };
  }

  const maxScanned = options.maxScanned ?? 50_000;
  const pageSize = options.pageSize ?? MAX_BACKLOG_LIMIT;
  let count = 0;
  let scanned = 0;
  let cursor: string | undefined;
  do {
    const page = await pageBacklog(
      db,
      grants,
      { kind, limit: pageSize, ...(cursor ? { cursor } : {}) },
      standards,
    );
    count += page.records.length;
    scanned += pageSize;
    cursor = page.nextCursor ?? undefined;
  } while (cursor && scanned < maxScanned);
  return { count, complete: cursor === undefined };
}
