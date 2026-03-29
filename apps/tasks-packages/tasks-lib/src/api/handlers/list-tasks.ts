import type { ApiEndpointDefinition, ApiRequest, ApiContext } from "@starkeep/shared-space-api";
import type { Task } from "../../types/task.js";
import { TASK_RECORD_TYPE, taskRecordToTask, decodeTdoFile } from "../../data/task-record.js";
import type { DataRecord } from "@starkeep/core";

export const listTasksHandler: ApiEndpointDefinition = {
  namespace: "tasks",
  version: "v1",
  path: "tasks",
  method: "GET",
  handler: async (request: ApiRequest, context: ApiContext) => {
    const query = request.query ?? {};
    const groupId = query["groupId"];

    if (!groupId) {
      return { status: 400, body: { error: "groupId query parameter is required" } };
    }

    const status = query["status"];
    const assignee = query["assignee"];
    const label = query["label"];
    const limit = query["limit"] ? parseInt(query["limit"], 10) : undefined;
    const cursor = query["cursor"];

    const queryResult = await context.databaseAdapter.query({
      type: TASK_RECORD_TYPE,
      filters: [{ field: "payload.groupId", operator: "eq", value: groupId }],
      limit,
      cursor,
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

      // Apply client-side filters
      if (status && content.status !== status) continue;
      if (assignee && content.assignee !== assignee) continue;
      if (label && !content.labels.includes(label)) continue;

      tasks.push(taskRecordToTask(dataRecord, content));
    }

    return {
      status: 200,
      body: {
        tasks,
        nextCursor: queryResult.nextCursor,
      },
    };
  },
};
