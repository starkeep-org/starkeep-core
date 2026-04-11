import type { ApiEndpointDefinition, ApiRequest, ApiContext } from "@starkeep/shared-space-api";
import type { TaskGroup } from "../../types/group.js";
import { GROUP_RECORD_TYPE, groupRecordToGroup, loadTdgFile } from "../../data/group-record.js";
import type { DataRecord } from "@starkeep/core";

export const listGroupsHandler: ApiEndpointDefinition = {
  namespace: "tasks",
  version: "v1",
  path: "groups",
  method: "GET",
  handler: async (_request: ApiRequest, context: ApiContext) => {
    const queryResult = await context.databaseAdapter.query({
      type: GROUP_RECORD_TYPE,
      filters: [{ field: "ownerId", operator: "eq", value: context.ownerId }],
    });

    const groups: TaskGroup[] = [];
    for (const record of queryResult.records) {
      const dataRecord = record as DataRecord;
      const fileContent = await loadTdgFile(dataRecord, context.objectStorageAdapter);
      if (!fileContent) continue;
      groups.push(groupRecordToGroup(dataRecord, fileContent));
    }

    return { status: 200, body: { groups } };
  },
};
