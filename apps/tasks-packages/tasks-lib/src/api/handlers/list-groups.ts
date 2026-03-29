import type { ApiEndpointDefinition, ApiRequest, ApiContext } from "@starkeep/shared-space-api";
import type { TaskGroup } from "../../types/group.js";
import { GROUP_RECORD_TYPE, groupRecordToGroup } from "../../data/group-record.js";
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

    const groups: TaskGroup[] = queryResult.records.map((record) =>
      groupRecordToGroup(record as DataRecord),
    );

    return { status: 200, body: { groups } };
  },
};
