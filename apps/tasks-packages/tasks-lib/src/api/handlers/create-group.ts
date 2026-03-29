import type { ApiEndpointDefinition, ApiRequest, ApiContext } from "@starkeep/shared-space-api";
import type { TaskGroupPayload } from "../../types/group.js";
import { createGroupRecord, groupRecordToGroup } from "../../data/group-record.js";
import { createOrderingRecord } from "../../data/ordering-record.js";

export const createGroupHandler: ApiEndpointDefinition = {
  namespace: "tasks",
  version: "v1",
  path: "groups",
  method: "POST",
  handler: async (request: ApiRequest, context: ApiContext) => {
    const body = request.body as { name?: string; description?: string } | undefined;

    if (!body?.name) {
      return { status: 400, body: { error: "name is required" } };
    }

    const payload: TaskGroupPayload = {
      name: body.name,
      description: body.description ?? "",
      ownerId: context.ownerId,
    };

    const groupRecord = createGroupRecord(payload, context.clock, context.ownerId);
    await context.databaseAdapter.put(groupRecord);

    const orderingRecord = createOrderingRecord(
      { groupId: groupRecord.id, orderedTaskIds: [] },
      context.clock,
      context.ownerId,
    );
    await context.databaseAdapter.put(orderingRecord);

    const group = groupRecordToGroup(groupRecord);
    return { status: 201, body: { group } };
  },
};
