/**
 * The Trash: deleted records, when each one goes for good, and the way back.
 *
 * A tombstone was invisible before this. Every records query hard-coded
 * `deleted_at IS NULL`, so "I deleted that" meant "I stopped seeing it", with no
 * list of what had gone and no way to undo one.
 *
 * ## The date is the whole promise
 *
 * A Trash without a scheduled deletion date promises nothing: an item that might
 * be reclaimed tomorrow and one that will still be there next year look identical.
 * So the list carries `deletes_at` per item, computed from the item's own
 * `deleted_at` and the library's configured retention window — and when this node
 * cannot read the winning settings file, `deletes_at` is null rather than a date
 * computed from a default the person may never have chosen.
 *
 * ## What the list cannot show
 *
 * Where the file sat. The watcher's private tracking table holds the path and
 * never syncs, and the record itself carries `original_filename` and no path at
 * all — which is correct, because where a file sat is a per-node fact. A Trash in
 * the cloud or on a second laptop has no path to show, so this does not promise one.
 */

import {
  DriveNotInstalledError,
  getTrashPolicy,
  listDeletedRecords,
  restoreRecord,
  type DriveRecord,
  type TrashPolicy,
} from "../lib/drive-client";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface TrashedRecord extends DriveRecord {
  /** When the reaper becomes free to reclaim the bytes, or null if unknown. */
  deletes_at: string | null;
}

export async function GET() {
  try {
    const [policy, records] = await Promise.all([getTrashPolicy(), listDeletedRecords()]);
    const trashed: TrashedRecord[] = records
      .map((r) => ({ ...r, deletes_at: scheduledDeletion(r.deleted_at ?? null, policy) }))
      // Newest deletion first: a Trash is read from the most recent mistake back.
      .sort((a, b) => (b.deleted_at ?? "").localeCompare(a.deleted_at ?? ""));
    return Response.json({ records: trashed, policy });
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST /api/trash/:id/restore — take one delete back. */
export async function RESTORE(id: string) {
  try {
    const { ids } = await restoreRecord(id);
    return Response.json({ restored: true, ids });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * When the bytes become eligible for reclamation.
 *
 * Null when this node does not know the library's value. Showing a date derived
 * from the platform default under a library whose owner chose a year would be
 * stating a promise the library does not make.
 */
function scheduledDeletion(deletedAt: string | null, policy: TrashPolicy): string | null {
  if (!deletedAt || policy.retention_days === null) return null;
  const at = Date.parse(deletedAt);
  if (Number.isNaN(at)) return null;
  return new Date(at + policy.retention_days * MS_PER_DAY).toISOString();
}

function errorResponse(err: unknown): Response {
  const status = err instanceof DriveNotInstalledError ? 503 : 502;
  return Response.json(
    { error: err instanceof Error ? err.message : String(err) },
    { status },
  );
}
