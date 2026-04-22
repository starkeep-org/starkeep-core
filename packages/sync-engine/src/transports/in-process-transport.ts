import {
  compareHLC,
  maxHLC,
  type AnyRecord,
  type HLCClock,
  type HLCTimestamp,
} from "@starkeep/core";
import type { DatabaseAdapter } from "@starkeep/storage-adapter";
import type {
  SyncTransport,
  SyncPullRequest,
  SyncPullResponse,
  SyncPushRequest,
  SyncPushResponse,
  ChangeLogEntry,
  RejectedChange,
} from "../types.js";
import { decidePushAccept } from "../conflict-resolver.js";

export interface InProcessTransportOptions {
  readonly databaseAdapter: DatabaseAdapter;
  readonly clock: HLCClock;
}

/**
 * `SyncTransport` that talks directly to an in-process database adapter.
 * Used for tests and for running a "cloud" side in the same Node process.
 *
 * Pull: queries the adapter for records whose `updatedAt` is after the
 * requested cursor and returns them as change-log entries.
 * Push: for each incoming change, applies the OCC rule via decidePushAccept.
 */
export function createInProcessSyncTransport(
  options: InProcessTransportOptions,
): SyncTransport {
  const { databaseAdapter, clock } = options;

  return {
    async pullChanges(request: SyncPullRequest): Promise<SyncPullResponse> {
      const result = await databaseAdapter.query({
        limit: Math.max(request.limit, 1000),
      });

      const changes: ChangeLogEntry[] = [];
      let latest: HLCTimestamp = request.sinceTimestamp;

      for (const record of result.records) {
        if (compareHLC(record.updatedAt, request.sinceTimestamp) <= 0) continue;
        changes.push(recordToChangeLogEntry(record));
        latest = maxHLC(latest, record.updatedAt);
        if (changes.length >= request.limit) break;
      }

      return {
        changes,
        latestTimestamp: latest,
        hasMore: changes.length >= request.limit && result.hasMore,
      };
    },

    async pushChanges(request: SyncPushRequest): Promise<SyncPushResponse> {
      const accepted: string[] = [];
      const rejected: RejectedChange[] = [];
      let latest: HLCTimestamp = { wallTime: 0, counter: 0, nodeId: "" };

      for (const change of request.changes) {
        const current = await databaseAdapter.get(change.recordId);
        const decision = decidePushAccept(current, change);

        if (decision.kind === "accept") {
          if (change.operation === "delete") {
            await databaseAdapter.delete(change.recordId);
          } else {
            await databaseAdapter.put(change.recordSnapshot);
          }
          accepted.push(change.recordId);
          latest = maxHLC(latest, change.timestamp);
        } else {
          rejected.push({
            recordId: change.recordId,
            clientChange: change,
            serverRecord: current,
            reason:
              decision.kind === "reject-not-found"
                ? "not-found"
                : decision.kind === "reject-deleted"
                  ? "deleted"
                  : "version-mismatch",
          });
        }
      }

      // Advance clock to account for the updates we just applied.
      for (const change of request.changes) {
        clock.receive(change.timestamp);
      }

      return {
        accepted: accepted as SyncPushResponse["accepted"],
        rejected,
        latestTimestamp: latest,
      };
    },
  };
}

function recordToChangeLogEntry(record: AnyRecord): ChangeLogEntry {
  return {
    changeId: record.id,
    recordId: record.id,
    operation: record.deletedAt ? "delete" : "update",
    timestamp: record.updatedAt,
    recordSnapshot: record,
    baseVersion: record.version > 1 ? record.version - 1 : null,
  };
}
