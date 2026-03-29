import type { ApiEndpointDefinition, ApiRequest, ApiContext } from "@starkeep/shared-space-api";
import type { StarkeepId } from "@starkeep/core";
import type { DataRecord } from "@starkeep/core";
import type { TaskGroupPayload } from "../../types/group.js";
import { groupRecordToGroup } from "../../data/group-record.js";

export const updateGroupHandler: ApiEndpointDefinition = {
  namespace: "tasks",
  version: "v1",
  path: "groups/item",
  method: "PUT",
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
    const existingPayload = dataRecord.payload as unknown as TaskGroupPayload;
    const body = (request.body ?? {}) as Partial<{ name: string; description: string }>;

    const updatedPayload: TaskGroupPayload = {
      ...existingPayload,
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
    };

    const updatedRecord: DataRecord = {
      ...dataRecord,
      updatedAt: context.clock.now(),
      payload: updatedPayload as unknown as Record<string, unknown>,
    };

    await context.databaseAdapter.put(updatedRecord);

    const group = groupRecordToGroup(updatedRecord);
    return { status: 200, body: { group } };
  },
};
