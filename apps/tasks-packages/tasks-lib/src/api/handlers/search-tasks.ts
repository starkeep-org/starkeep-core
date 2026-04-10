import type { ApiEndpointDefinition, ApiRequest, ApiContext } from "@starkeep/shared-space-api";
import type { Task } from "../../types/task.js";
import { TASK_RECORD_TYPE, taskRecordToTask, decodeTdoFile } from "../../data/task-record.js";
import type { DataRecord } from "@starkeep/core";

export const searchTasksHandler: ApiEndpointDefinition = {
  namespace: "tasks",
  version: "v1",
  path: "tasks/search",
  method: "GET",
  handler: async (request: ApiRequest, context: ApiContext) => {
    const query = request.query ?? {};
    const q = query["q"];

    if (!q) {
      return { status: 400, body: { error: "q query parameter is required" } };
    }

    const groupId = query["groupId"];
    const limit = query["limit"] ? parseInt(query["limit"], 10) : undefined;
    const searchLower = q.toLowerCase();

    const filters = groupId
      ? [{ field: "content.groupId", operator: "eq" as const, value: groupId }]
      : [];

    const queryResult = await context.databaseAdapter.query({
      type: TASK_RECORD_TYPE,
      filters,
      limit,
    });

    const tasks: Task[] = [];

    for (const record of queryResult.records) {
      const dataRecord = record as DataRecord;
      if (!dataRecord.objectStorageKey) continue;

      const fileResult = await context.objectStorageAdapter.get(dataRecord.objectStorageKey);
      if (!fileResult) continue;

      const content = decodeTdoFile(
        fileResult.data instanceof Uint8Array
          ? fileResult.data
          : new Uint8Array(fileResult.data as ArrayBuffer),
      );

      const titleMatch = content.title.toLowerCase().includes(searchLower);
      const descriptionMatch = content.description.toLowerCase().includes(searchLower);

      if (!titleMatch && !descriptionMatch) continue;

      tasks.push(taskRecordToTask(dataRecord, content));
    }

    return { status: 200, body: { tasks } };
  },
};
