import { createDataRecord, type DataRecord, type HLCClock } from "@starkeep/core";
import type { TaskOrderingPayload } from "../types/ordering.js";

export const ORDERING_RECORD_TYPE = "tasks:ordering";

export function createOrderingRecord(
  content: TaskOrderingPayload,
  clock: HLCClock,
  ownerId: string,
): DataRecord {
  return createDataRecord(
    {
      type: ORDERING_RECORD_TYPE,
      ownerId,
      content: content as unknown as Record<string, unknown>,
    },
    clock,
  );
}

export function getOrderingPayload(record: DataRecord): TaskOrderingPayload {
  return record.content as unknown as TaskOrderingPayload;
}

/** Insert a task ID at the given index, or append if index is out of bounds. */
export function insertTaskInOrdering(
  content: TaskOrderingPayload,
  taskId: string,
  atIndex: number,
): TaskOrderingPayload {
  const ids = [...content.orderedTaskIds];
  const clampedIndex = Math.max(0, Math.min(atIndex, ids.length));
  ids.splice(clampedIndex, 0, taskId);
  return { ...content, orderedTaskIds: ids };
}

/** Remove a task ID from the ordering (e.g. on delete). */
export function removeTaskFromOrdering(
  content: TaskOrderingPayload,
  taskId: string,
): TaskOrderingPayload {
  return {
    ...content,
    orderedTaskIds: content.orderedTaskIds.filter((id) => id !== taskId),
  };
}
