import type { ApiEndpointDefinition, ApiRequest, ApiContext } from "@starkeep/shared-space-api";
import type { StarkeepId } from "@starkeep/core";
import type { DataRecord } from "@starkeep/core";
import { groupRecordToGroup, loadTdgFile } from "../../data/group-record.js";

export const getGroupHandler: ApiEndpointDefinition = {
  namespace: "tasks",
  version: "v1",
  path: "groups/item",
  method: "GET",
  handler: async (request: ApiRequest, context: ApiContext) => {
    const query = request.query ?? {};
    const id = query["id"];

    if (!id) {
      return { status: 400, body: { error: "id query parameter is required" } };
    }

    const record = await context.databaseAdapter.get(id as StarkeepId);
    if (!record) {
      return { status: 404, body: { error: "Group not found" } };
    }

    const dataRecord = record as DataRecord;
    const fileContent = await loadTdgFile(dataRecord, context.objectStorageAdapter);
    if (!fileContent) {
      return { status: 404, body: { error: "Group file not found" } };
    }

    const group = groupRecordToGroup(dataRecord, fileContent);
    return { status: 200, body: { group } };
  },
};
