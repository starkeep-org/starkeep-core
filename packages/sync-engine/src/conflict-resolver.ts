import type { AnyRecord } from "@starkeep/core";
import type { RecordChangeLogEntry } from "./types.js";

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
 *  - skip-already-current: we already have this version (or newer).
 */
export function decidePullApply(
  localRecord: AnyRecord | null,
  remoteChange: RecordChangeLogEntry,
  localUnsyncedChangeForRecord: RecordChangeLogEntry | undefined,
): PullApplyDecision {
  if (localUnsyncedChangeForRecord) {
    return { kind: "local-dirty-conflict" };
  }
  if (!localRecord) {
    return { kind: "apply-clean" };
  }
  if (localRecord.version >= remoteChange.recordSnapshot.version) {
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
  | "reject-version-mismatch"
  | "reject-not-found"
  | "reject-deleted";

export interface PushAcceptDecision {
  readonly kind: PushAcceptKind;
}

export function decidePushAccept(
  currentServerRecord: AnyRecord | null,
  incomingChange: RecordChangeLogEntry,
): PushAcceptDecision {
  if (incomingChange.operation === "create") {
    if (currentServerRecord) {
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

  if (currentServerRecord.version !== incomingChange.baseVersion) {
    return { kind: "reject-version-mismatch" };
  }

  return { kind: "accept" };
}
