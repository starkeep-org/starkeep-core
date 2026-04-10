import type { ApiEndpointDefinition, ApiRequest, ApiContext } from "@starkeep/shared-space-api";
import type { StarkeepId } from "@starkeep/core";
import type { DataRecord } from "@starkeep/core";
import type { TdgFileContent } from "../../types/group.js";
import { loadTdgFile, writeTdgFile } from "../../data/group-record.js";

export const deleteTaskHandler: ApiEndpointDefinition = {
  namespace: "tasks",
  version: "v1",
  path: "tasks/item",
  method: "DELETE",
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
    const groupId = (dataRecord.content as { groupId?: string }).groupId;

    // Remove task from group ordering before deleting
    if (groupId) {
      const groupRecord = await context.databaseAdapter.get(groupId as StarkeepId);
      if (groupRecord) {
        const groupDataRecord = groupRecord as DataRecord;
        const fileContent = await loadTdgFile(groupDataRecord, context.objectStorageAdapter);
        if (fileContent) {
          const newContent: TdgFileContent = {
            ...fileContent,
            orderedTaskIds: fileContent.orderedTaskIds.filter((tid) => tid !== id),
          };
          const { updatedRecord } = await writeTdgFile(
            groupDataRecord,
            newContent,
            context.objectStorageAdapter,
            context.clock,
          );
          await context.databaseAdapter.put(updatedRecord);
        }
      }
    }

    await context.databaseAdapter.delete(id as StarkeepId);

    return { status: 200, body: { success: true } };
  },
};
