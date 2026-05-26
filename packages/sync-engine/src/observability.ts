import { SyncStatus } from "@starkeep/core";
import type { DatabaseAdapter } from "@starkeep/storage-adapter";

export type TransitionSide = "client" | "server";

function isSilenced(): boolean {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.STARKEEP_SYNC_LOG === "off";
}

/**
 * Emit a single structured log line for a record state-machine transition.
 * Format: `[sync-state] side=<...> record=<...> from=<...> to=<...> reason=<...>`.
 * Verbose by default — gate via `STARKEEP_SYNC_LOG=off` to silence.
 */
export function logTransition(
  side: TransitionSide,
  recordId: string,
  from: SyncStatus | null,
  to: SyncStatus,
  reason: string,
): void {
  if (isSilenced()) return;
  console.info(
    `[sync-state] side=${side} record=${recordId} from=${from ?? "none"} to=${to} reason=${reason}`,
  );
}

export interface NonTerminalCounts {
  readonly pendingPush: number;
  readonly pendingFileUpload: number;
  readonly pendingFileDownload: number;
  readonly conflict: number;
}

/**
 * Count records sitting in non-terminal sync states. Useful for spotting
 * records stuck mid-state-machine (e.g. a PendingFileDownload whose blob never
 * landed). Returns zero for all buckets if everything is Synced.
 */
export async function countNonTerminal(
  db: DatabaseAdapter,
): Promise<NonTerminalCounts> {
  const [pendingPush, pendingFileUpload, pendingFileDownload, conflict] =
    await Promise.all([
      db
        .query({
          filters: [{ field: "syncStatus", operator: "eq", value: SyncStatus.PendingPush }],
          limit: 10_000,
        })
        .then((r) => r.records.length),
      db
        .query({
          filters: [{ field: "syncStatus", operator: "eq", value: SyncStatus.PendingFileUpload }],
          limit: 10_000,
        })
        .then((r) => r.records.length),
      db
        .query({
          filters: [{ field: "syncStatus", operator: "eq", value: SyncStatus.PendingFileDownload }],
          limit: 10_000,
        })
        .then((r) => r.records.length),
      db
        .query({
          filters: [{ field: "syncStatus", operator: "eq", value: SyncStatus.Conflict }],
          limit: 10_000,
        })
        .then((r) => r.records.length),
    ]);
  return { pendingPush, pendingFileUpload, pendingFileDownload, conflict };
}

/**
 * Log non-terminal counts if any bucket is non-zero. Silent on a fully-synced
 * database so steady state doesn't spam logs.
 */
export function logNonTerminalCounts(
  side: TransitionSide,
  counts: NonTerminalCounts,
): void {
  if (isSilenced()) return;
  const total =
    counts.pendingPush +
    counts.pendingFileUpload +
    counts.pendingFileDownload +
    counts.conflict;
  if (total === 0) return;
  console.info(
    `[sync-state] side=${side} non-terminal pendingPush=${counts.pendingPush} pendingFileUpload=${counts.pendingFileUpload} pendingFileDownload=${counts.pendingFileDownload} conflict=${counts.conflict}`,
  );
}
