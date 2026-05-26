import type { AnyRecord } from "@starkeep/core";
import type { ChangeLogEntry } from "./types.js";

export type PullApplyKind =
  | "apply-clean"
  | "local-dirty-conflict"
  | "skip-already-current";

export interface PullApplyDecision {
  readonly kind: PullApplyKind;
}

/**
 * Decide what to do when a remote change arrives during a pull.
 *
 *  - apply-clean: local record is absent or strictly older than the remote.
 *  - local-dirty-conflict: local has an unsynced change to this record;
 *    the app must resolve before we overwrite.
 *  - skip-already-current: we already have this version (or newer) AND the
 *    file (if any) has already been pulled. A local record at matching
 *    version but still in PendingFileDownload is not "current" — the file
 *    transfer is still owed and the retry pass needs to see it.
 */
export function decidePullApply(
  localRecord: AnyRecord | null,
  remoteChange: ChangeLogEntry,
  localUnsyncedChangeForRecord: ChangeLogEntry | undefined,
): PullApplyDecision {
  if (localUnsyncedChangeForRecord) {
    return { kind: "local-dirty-conflict" };
  }
  if (!localRecord) {
    return { kind: "apply-clean" };
  }
  if (localRecord.version >= remoteChange.recordSnapshot.version) {
    // Metadata is current — but the file retry pass (driven off
    // SyncStatus.PendingFileDownload) is what gets the blob across. The metadata
    // path doesn't need to re-write the row.
    return { kind: "skip-already-current" };
  }
  return { kind: "apply-clean" };
}

/**
 * Authoritative server-side OCC check. Called on the cloud for each incoming
 * push change.
 */
export type PushAcceptKind =
  | "accept"
  | "accept-noop"
  | "reject-version-mismatch"
  | "reject-not-found"
  | "reject-deleted";

export interface PushAcceptDecision {
  readonly kind: PushAcceptKind;
}

/**
 * Authoritative server-side OCC check. Called on the cloud for each incoming
 * push change.
 *
 * `accept-noop` means the server already has this exact (id, version) — the
 * client is retrying a push whose response was lost. The server should re-send
 * an accept without applying anything, so the client can advance its state
 * machine (PendingPush → PendingFileUpload).
 */
export function decidePushAccept(
  currentServerRecord: AnyRecord | null,
  incomingChange: ChangeLogEntry,
): PushAcceptDecision {
  if (incomingChange.operation === "create") {
    if (currentServerRecord) {
      if (isSameRevision(currentServerRecord, incomingChange.recordSnapshot)) {
        return { kind: "accept-noop" };
      }
      return { kind: "reject-version-mismatch" };
    }
    return { kind: "accept" };
  }

  if (!currentServerRecord) {
    return { kind: "reject-not-found" };
  }

  if (currentServerRecord.deletedAt && incomingChange.operation !== "delete") {
    return { kind: "reject-deleted" };
  }

  if (isSameRevision(currentServerRecord, incomingChange.recordSnapshot)) {
    return { kind: "accept-noop" };
  }

  if (currentServerRecord.version !== incomingChange.baseVersion) {
    return { kind: "reject-version-mismatch" };
  }

  return { kind: "accept" };
}

/**
 * True iff the server's current record and the incoming snapshot describe the
 * same revision. Equivalence on (id, version, updatedAt-HLC) distinguishes a
 * retried push (identical HLC because it's the same edit) from a genuine
 * concurrent edit (different HLC because produced on a different node).
 */
function isSameRevision(a: AnyRecord, b: AnyRecord): boolean {
  return (
    a.id === b.id &&
    a.version === b.version &&
    a.updatedAt.wallTime === b.updatedAt.wallTime &&
    a.updatedAt.counter === b.updatedAt.counter &&
    a.updatedAt.nodeId === b.updatedAt.nodeId
  );
}
