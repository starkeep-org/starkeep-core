import type { ApiEndpointDefinition, ApiRequest, ApiContext } from "@starkeep/shared-space-api";
import type { StarkeepId } from "@starkeep/core";
import type { DataRecord } from "@starkeep/core";
import type { TdgFileContent } from "../../types/group.js";
import { groupRecordToGroup, loadTdgFile, writeTdgFile } from "../../data/group-record.js";

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
    const existing = await loadTdgFile(dataRecord, context.objectStorageAdapter);
    if (!existing) {
      return { status: 404, body: { error: "Group file not found" } };
    }

    const body = (request.body ?? {}) as Partial<{ name: string; description: string }>;
    const newContent: TdgFileContent = {
      ...existing,
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
    };

    const { updatedRecord } = await writeTdgFile(
      dataRecord,
      newContent,
      context.objectStorageAdapter,
      context.clock,
    );

    // Keep DataRecord payload in sync with the file's name/description/ownerId
    const finalRecord: DataRecord = {
      ...updatedRecord,
      payload: {
        name: newContent.name,
        description: newContent.description,
        ownerId: newContent.ownerId,
      } as unknown as Record<string, unknown>,
    };
    await context.databaseAdapter.put(finalRecord);

    const group = groupRecordToGroup(finalRecord, newContent);
    return { status: 200, body: { group } };
  },
};
