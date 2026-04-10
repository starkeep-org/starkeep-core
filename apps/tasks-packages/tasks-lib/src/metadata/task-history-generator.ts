import { serializeHLC, generateId } from "@starkeep/core";
import type { GeneratingFunctionDefinition, GeneratingFunctionInput, GenerationContext } from "@starkeep/metadata-engine";
import { TASK_RECORD_TYPE, decodeTdoFile } from "../data/task-record.js";
import type { TdoFileContent } from "../types/task.js";

export const TASK_HISTORY_GENERATOR_ID = "tasks:history";

const TRACKED_FIELDS: (keyof TdoFileContent)[] = [
  "title",
  "description",
  "assignee",
  "status",
  "labels",
  "blockers",
];

export interface HistoryEntry {
  entryId: string;
  timestamp: string; // serialized HLC
  actorId: string;
  changes: Record<string, { from: unknown; to: unknown }>;
}

export interface TaskHistoryValue {
  entries: HistoryEntry[];
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export const taskHistoryGenerator: GeneratingFunctionDefinition = {
  generatorId: TASK_HISTORY_GENERATOR_ID,
  generatorVersion: 1,
  inputTypes: [TASK_RECORD_TYPE],
  dependsOn: [],
  outputColumns: [
    { name: "history_entries", columnType: "text" },
  ],

  async generate(
    input: GeneratingFunctionInput,
    context: GenerationContext,
  ) {
    const record = await context.databaseAdapter.get(input.dataRecordId);
    if (!record || !record.objectStorageKey) {
      throw new Error(`Task record not found or has no file: ${input.dataRecordId}`);
    }

    const fileResult = await context.objectStorageAdapter.get(record.objectStorageKey);
    if (!fileResult) {
      throw new Error(`Task file not found in object storage: ${record.objectStorageKey}`);
    }
    const current: TdoFileContent = decodeTdoFile(fileResult.data);

    // Load previous history value if it exists
    const existingMetadata = await context.databaseAdapter.queryMetadata(input.targetType, {
      targetId: input.dataRecordId,
      generatorId: TASK_HISTORY_GENERATOR_ID,
    });

    const previousHistory: TaskHistoryValue =
      existingMetadata.entries[0]
        ? (existingMetadata.entries[0].value as unknown as TaskHistoryValue)
        : { entries: [] };

    // Recover previous content state from history to compute diff.
    // We store a snapshot of all tracked fields at each entry.
    const lastEntry = previousHistory.entries[previousHistory.entries.length - 1];
    const previous = lastEntry
      ? (lastEntry as HistoryEntry & { snapshot?: Partial<TdoFileContent> }).snapshot
      : undefined;

    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const field of TRACKED_FIELDS) {
      const currentVal = current[field];
      const previousVal = previous ? previous[field] : undefined;
      if (!deepEqual(currentVal, previousVal)) {
        changes[field] = { from: previousVal, to: currentVal };
      }
    }

    if (Object.keys(changes).length === 0 && previousHistory.entries.length > 0) {
      // No changes — return existing history unchanged
      return { value: previousHistory as unknown as Record<string, unknown> };
    }

    const snapshot: Partial<TdoFileContent> = {};
    for (const field of TRACKED_FIELDS) {
      (snapshot as Record<string, unknown>)[field] = current[field];
    }

    const newEntry: HistoryEntry & { snapshot: Partial<TdoFileContent> } = {
      entryId: generateId(),
      timestamp: serializeHLC(context.clock.now()),
      actorId: context.ownerId,
      changes,
      snapshot,
    };

    const updatedHistory: TaskHistoryValue = {
      entries: [...previousHistory.entries, newEntry],
    };

    return { value: updatedHistory as unknown as Record<string, unknown> };
  },
};
