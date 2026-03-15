import { compareHLC } from "@starkeep/core";
import type { AnyRecord } from "@starkeep/core";
import type { ChangeLogEntry, ConflictResolution } from "./types.js";

export function resolveConflict(
  localChange: ChangeLogEntry,
  remoteChange: ChangeLogEntry,
): ConflictResolution {
  const localRecord = localChange.recordSnapshot;
  const remoteRecord = remoteChange.recordSnapshot;

  // compareHLC provides total ordering: wallTime > counter > nodeId
  const localWins = compareHLC(
    localRecord.updatedAt,
    remoteRecord.updatedAt,
  ) >= 0;

  const winner: "local" | "remote" = localWins ? "local" : "remote";
  const resolvedRecord: AnyRecord = localWins ? localRecord : remoteRecord;

  return {
    recordId: localChange.recordId,
    localChange,
    remoteChange,
    winner,
    resolvedRecord,
  };
}
