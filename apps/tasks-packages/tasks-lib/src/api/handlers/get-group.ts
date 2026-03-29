import type { ApiEndpointDefinition, ApiRequest, ApiContext } from "@starkeep/shared-space-api";
import type { StarkeepId } from "@starkeep/core";
import type { DataRecord } from "@starkeep/core";
import { groupRecordToGroup } from "../../data/group-record.js";

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

    const group = groupRecordToGroup(record as DataRecord);
    return { status: 200, body: { group } };
  },
};
