import type { ApiEndpointDefinition, ApiRequest, ApiContext } from "@starkeep/shared-space-api";

async function sha256Hex(data: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
import type { TdoFileContent } from "../../types/task.js";
import {
  createTaskRecord,
  taskRecordToTask,
  encodeTdoFile,
} from "../../data/task-record.js";
import {
  ORDERING_RECORD_TYPE,
  getOrderingPayload,
  insertTaskInOrdering,
} from "../../data/ordering-record.js";
import type { DataRecord } from "@starkeep/core";

export const createTaskHandler: ApiEndpointDefinition = {
  namespace: "tasks",
  version: "v1",
  path: "tasks",
  method: "POST",
  handler: async (request: ApiRequest, context: ApiContext) => {
    const body = request.body as Partial<TdoFileContent> | undefined;

    if (!body) {
      return { status: 400, body: { error: "Request body is required" } };
    }

    if (!body.groupId) {
      return { status: 400, body: { error: "groupId is required" } };
    }
    if (!body.title) {
      return { status: 400, body: { error: "title is required" } };
    }
    if (!body.status) {
      return { status: 400, body: { error: "status is required" } };
    }

    const content: TdoFileContent = {
      groupId: body.groupId,
      title: body.title,
      description: body.description ?? "",
      assignee: body.assignee ?? null,
      status: body.status,
      blockers: body.blockers ?? [],
      labels: body.labels ?? [],
      comments: body.comments ?? [],
    };

    const fileBytes = encodeTdoFile(content);
    const contentHash = await sha256Hex(fileBytes);
    const objectStorageKey = `tasks/${contentHash.slice(0, 2)}/${contentHash}.tdo`;

    await context.objectStorageAdapter.put(objectStorageKey, fileBytes, {
      contentType: "application/json",
    });

    const record = createTaskRecord(
      content,
      fileBytes,
      objectStorageKey,
      contentHash,
      context.clock,
      context.ownerId,
    );

    await context.databaseAdapter.put(record);

    // Append task to the group's ordering record
    const orderingResult = await context.databaseAdapter.query({
      type: ORDERING_RECORD_TYPE,
      filters: [{ field: "payload.groupId", operator: "eq", value: content.groupId }],
      limit: 1,
    });
    if (orderingResult.records.length > 0) {
      const orderingRecord = orderingResult.records[0] as DataRecord;
      const payload = getOrderingPayload(orderingRecord);
      const updated = insertTaskInOrdering(payload, record.id, payload.orderedTaskIds.length);
      await context.databaseAdapter.put({ ...orderingRecord, payload: updated as unknown as Record<string, unknown>, updatedAt: context.clock.now() });
    }

    const task = taskRecordToTask(record, content);
    return { status: 201, body: { task } };
  },
};
