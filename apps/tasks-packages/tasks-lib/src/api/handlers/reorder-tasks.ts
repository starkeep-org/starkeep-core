import type { ApiEndpointDefinition, ApiRequest, ApiContext } from "@starkeep/shared-space-api";
import { ORDERING_RECORD_TYPE, getOrderingPayload } from "../../data/ordering-record.js";
import type { DataRecord } from "@starkeep/core";

export const reorderTasksHandler: ApiEndpointDefinition = {
  namespace: "tasks",
  version: "v1",
  path: "tasks/reorder",
  method: "POST",
  handler: async (request: ApiRequest, context: ApiContext) => {
    const body = request.body as { groupId?: string; taskId?: string; newIndex?: number } | undefined;

    if (!body?.groupId || !body?.taskId || body?.newIndex === undefined) {
      return { status: 400, body: { error: "groupId, taskId, and newIndex are required" } };
    }

    const { groupId, taskId, newIndex } = body;

    const orderingResult = await context.databaseAdapter.query({
      type: ORDERING_RECORD_TYPE,
      filters: [{ field: "payload.groupId", operator: "eq", value: groupId }],
      sort: [{ field: "updatedAt", direction: "desc" }],
      limit: 1,
    });

    if (orderingResult.records.length === 0) {
      return { status: 404, body: { error: `No ordering record found for group ${groupId}` } };
    }

    const orderingRecord = orderingResult.records[0] as DataRecord;
    const payload = getOrderingPayload(orderingRecord);

    const filtered = payload.orderedTaskIds.filter((id) => id !== taskId);
    const clampedIndex = Math.max(0, Math.min(newIndex, filtered.length));
    filtered.splice(clampedIndex, 0, taskId);

    await context.databaseAdapter.put({
      ...orderingRecord,
      payload: { groupId, orderedTaskIds: filtered } as unknown as Record<string, unknown>,
      updatedAt: context.clock.now(),
    });

    return { status: 200, body: { success: true, newOrder: filtered } };
  },
};
