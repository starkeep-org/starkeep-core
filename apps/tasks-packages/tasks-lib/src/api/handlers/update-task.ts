import type { ApiEndpointDefinition, ApiRequest, ApiContext } from "@starkeep/shared-space-api";

async function sha256Hex(data: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
import type { StarkeepId } from "@starkeep/core";
import type { DataRecord } from "@starkeep/core";
import type { TdoFileContent } from "../../types/task.js";
import {
  taskRecordToTask,
  encodeTdoFile,
  decodeTdoFile,
} from "../../data/task-record.js";

export const updateTaskHandler: ApiEndpointDefinition = {
  namespace: "tasks",
  version: "v1",
  path: "tasks/item",
  method: "PUT",
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

    const existingContent = decodeTdoFile(
      fileResult.data instanceof Uint8Array
        ? fileResult.data
        : new Uint8Array(fileResult.data as ArrayBuffer),
    );

    const body = (request.body ?? {}) as Partial<TdoFileContent>;
    const updatedContent: TdoFileContent = { ...existingContent, ...body };

    const fileBytes = encodeTdoFile(updatedContent);
    const newHash = await sha256Hex(fileBytes);
    const newKey = `tasks/${newHash.slice(0, 2)}/${newHash}.tdo`;

    await context.objectStorageAdapter.put(newKey, fileBytes, {
      contentType: "application/json",
    });

    const updatedRecord: DataRecord = {
      ...dataRecord,
      contentHash: newHash,
      objectStorageKey: newKey,
      updatedAt: context.clock.now(),
      payload: { groupId: updatedContent.groupId },
    };

    await context.databaseAdapter.put(updatedRecord);

    const task = taskRecordToTask(updatedRecord, updatedContent);
    return { status: 200, body: { task } };
  },
};
