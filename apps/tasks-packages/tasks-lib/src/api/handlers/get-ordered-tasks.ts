import type { ApiEndpointDefinition, ApiRequest, ApiContext } from "@starkeep/shared-space-api";
import type { Task } from "../../types/task.js";
import { TASK_RECORD_TYPE, taskRecordToTask, decodeTdoFile } from "../../data/task-record.js";
import {
  ORDERING_RECORD_TYPE,
  getOrderingPayload,
} from "../../data/ordering-record.js";
import { importanceOrder } from "../../ordering/importance-order.js";
import { comprehensiveOrder } from "../../ordering/comprehensive-order.js";
import type { DataRecord } from "@starkeep/core";
import type { TaskOrderingPayload } from "../../types/ordering.js";

export const getOrderedTasksHandler: ApiEndpointDefinition = {
  namespace: "tasks",
  version: "v1",
  path: "tasks/ordered",
  method: "GET",
  handler: async (request: ApiRequest, context: ApiContext) => {
    const query = request.query ?? {};
    const groupId = query["groupId"];

    if (!groupId) {
      return { status: 400, body: { error: "groupId query parameter is required" } };
    }

    const mode = query["mode"] ?? "comprehensive";
    if (mode !== "importance" && mode !== "comprehensive") {
      return {
        status: 400,
        body: { error: 'mode must be "importance" or "comprehensive"' },
      };
    }

    // Fetch the ordering record for this group
    const orderingResult = await context.databaseAdapter.query({
      type: ORDERING_RECORD_TYPE,
      filters: [{ field: "payload.groupId", operator: "eq", value: groupId }],
      limit: 1,
    });

    let ordering: TaskOrderingPayload = { groupId, orderedTaskIds: [] };
    if (orderingResult.records.length > 0) {
      ordering = getOrderingPayload(orderingResult.records[0] as DataRecord);
    }

    // Fetch all task records for the group
    const taskResult = await context.databaseAdapter.query({
      type: TASK_RECORD_TYPE,
      filters: [{ field: "payload.groupId", operator: "eq", value: groupId }],
    });

    const tasks: Task[] = [];

    for (const record of taskResult.records) {
      const dataRecord = record as DataRecord;
      if (!dataRecord.objectStorageKey) continue;

      const fileResult = await context.objectStorageAdapter.get(dataRecord.objectStorageKey);
      if (!fileResult) continue;

      const content = decodeTdoFile(
        fileResult.data instanceof Uint8Array
          ? fileResult.data
          : new Uint8Array(fileResult.data as ArrayBuffer),
      );

      tasks.push(taskRecordToTask(dataRecord, content));
    }

    const orderedTasks =
      mode === "importance"
        ? importanceOrder(tasks, ordering)
        : comprehensiveOrder(tasks, ordering);

    return { status: 200, body: { tasks: orderedTasks } };
  },
};
