import type { ApiEndpointDefinition, ApiRequest, ApiContext } from "@starkeep/shared-space-api";
import type { StarkeepId } from "@starkeep/core";
import type { DataRecord } from "@starkeep/core";
import { taskRecordToTask, decodeTdoFile } from "../../data/task-record.js";

export const getTaskHandler: ApiEndpointDefinition = {
  namespace: "tasks",
  version: "v1",
  path: "tasks/item",
  method: "GET",
  handler: async (request: ApiRequest, context: ApiContext) => {
    const query = request.query ?? {};
    const id = query["id"];

    if (!id) {
      return { status: 400, body: { error: "id query parameter is required" } };
    }

    const record = await context.databaseAdapter.get(id as StarkeepId);
    if (!record) {
      return { status: 404, body: { error: "Task not found" } };
    }

    const dataRecord = record as DataRecord;
    if (!dataRecord.objectStorageKey) {
      return { status: 404, body: { error: "Task file not found" } };
    }

    const fileResult = await context.objectStorageAdapter.get(dataRecord.objectStorageKey);
    if (!fileResult) {
      return { status: 404, body: { error: "Task file not found in object storage" } };
    }

    const content = decodeTdoFile(
      fileResult.data instanceof Uint8Array
        ? fileResult.data
        : new Uint8Array(fileResult.data as ArrayBuffer),
    );

    const task = taskRecordToTask(dataRecord, content);
    return { status: 200, body: { task } };
  },
};
