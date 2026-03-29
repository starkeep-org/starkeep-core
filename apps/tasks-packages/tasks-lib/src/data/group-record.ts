import { createDataRecord, serializeHLC, type DataRecord, type HLCClock } from "@starkeep/core";
import type { TaskGroupPayload, TaskGroup } from "../types/group.js";

export const GROUP_RECORD_TYPE = "tasks:group";

export function createGroupRecord(
  payload: TaskGroupPayload,
  clock: HLCClock,
  ownerId: string,
): DataRecord {
  return createDataRecord(
    {
      type: GROUP_RECORD_TYPE,
      ownerId,
      payload: payload as unknown as Record<string, unknown>,
    },
    clock,
  );
}

export function groupRecordToGroup(record: DataRecord): TaskGroup {
  return {
    id: record.id,
    payload: record.payload as unknown as TaskGroupPayload,
    createdAt: serializeHLC(record.createdAt),
    updatedAt: serializeHLC(record.updatedAt),
  };
}
