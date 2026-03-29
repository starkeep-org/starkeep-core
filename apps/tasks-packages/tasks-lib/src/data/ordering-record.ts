import { createDataRecord, type DataRecord, type HLCClock } from "@starkeep/core";
import type { TaskOrderingPayload } from "../types/ordering.js";

export const ORDERING_RECORD_TYPE = "tasks:ordering";

export function createOrderingRecord(
  payload: TaskOrderingPayload,
  clock: HLCClock,
  ownerId: string,
): DataRecord {
  return createDataRecord(
    {
      type: ORDERING_RECORD_TYPE,
      ownerId,
      payload: payload as unknown as Record<string, unknown>,
    },
    clock,
  );
}

export function getOrderingPayload(record: DataRecord): TaskOrderingPayload {
  return record.payload as unknown as TaskOrderingPayload;
}

/** Insert a task ID at the given index, or append if index is out of bounds. */
export function insertTaskInOrdering(
  payload: TaskOrderingPayload,
  taskId: string,
  atIndex: number,
): TaskOrderingPayload {
  const ids = [...payload.orderedTaskIds];
  const clampedIndex = Math.max(0, Math.min(atIndex, ids.length));
  ids.splice(clampedIndex, 0, taskId);
  return { ...payload, orderedTaskIds: ids };
}

/** Remove a task ID from the ordering (e.g. on delete). */
export function removeTaskFromOrdering(
  payload: TaskOrderingPayload,
  taskId: string,
): TaskOrderingPayload {
  return {
    ...payload,
    orderedTaskIds: payload.orderedTaskIds.filter((id) => id !== taskId),
  };
}
