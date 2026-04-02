import type { ApiEndpointDefinition, ApiRequest, ApiContext } from "@starkeep/shared-space-api";
import type { StarkeepId } from "@starkeep/core";
import type { DataRecord } from "@starkeep/core";
import type { TdgFileContent } from "../../types/group.js";
import { loadTdgFile, writeTdgFile } from "../../data/group-record.js";

export const setTaskOrderHandler: ApiEndpointDefinition = {
  namespace: "tasks",
  version: "v1",
  path: "tasks/order",
  method: "POST",
  handler: async (request: ApiRequest, context: ApiContext) => {
    const body = request.body as { groupId?: string; orderedTaskIds?: string[] } | undefined;

    if (!body?.groupId || !Array.isArray(body.orderedTaskIds)) {
      return {
        status: 400,
        body: { error: "groupId and orderedTaskIds array are required" },
      };
    }

    const { groupId, orderedTaskIds } = body;

    const groupRecord = await context.databaseAdapter.get(groupId as StarkeepId);
    if (!groupRecord) {
      return { status: 404, body: { error: `Group ${groupId} not found` } };
    }

    const groupDataRecord = groupRecord as DataRecord;
    const existing = await loadTdgFile(groupDataRecord, context.objectStorageAdapter);
    if (!existing) {
      return { status: 404, body: { error: "Group file not found" } };
    }

    const newContent: TdgFileContent = { ...existing, orderedTaskIds };
    const { updatedRecord } = await writeTdgFile(
      groupDataRecord,
      newContent,
      context.objectStorageAdapter,
      context.clock,
    );
    await context.databaseAdapter.put(updatedRecord);

    return { status: 200, body: { success: true, orderedTaskIds } };
  },
};
