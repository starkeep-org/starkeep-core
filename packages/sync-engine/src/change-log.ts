import { generateId, compareHLC, maxHLC } from "@starkeep/core";
import type { HLCTimestamp } from "@starkeep/core";
import type { ChangeLog, ChangeLogEntry } from "./types.js";

export function createChangeLog(): ChangeLog {
  const entries: ChangeLogEntry[] = [];

  return {
    async append(
      entry: Omit<ChangeLogEntry, "changeId">,
    ): Promise<ChangeLogEntry> {
      const fullEntry: ChangeLogEntry = {
        ...entry,
        changeId: generateId(),
      };
      entries.push(fullEntry);
      return fullEntry;
    },

    async getChangesSince(
      timestamp: HLCTimestamp,
    ): Promise<ChangeLogEntry[]> {
      return entries.filter(
        (entry) => compareHLC(entry.timestamp, timestamp) > 0,
      );
    },

    async getLatestTimestamp(): Promise<HLCTimestamp | null> {
      if (entries.length === 0) return null;
      return entries.reduce(
        (latest, entry) => maxHLC(latest, entry.timestamp),
        entries[0].timestamp,
      );
    },

    async prune(olderThan: HLCTimestamp): Promise<number> {
      const initialLength = entries.length;
      const remaining = entries.filter(
        (entry) => compareHLC(entry.timestamp, olderThan) >= 0,
      );
      entries.length = 0;
      entries.push(...remaining);
      return initialLength - entries.length;
    },
  };
}
