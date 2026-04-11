import type { ApiEndpointDefinition, ApiRequest, ApiContext } from "@starkeep/shared-space-api";
import type { TaskGroupPayload } from "../../types/group.js";
import type { TdgFileContent } from "../../types/group.js";
import {
  createGroupRecord,
  groupRecordToGroup,
  encodeTdgFile,
  groupObjectStorageKey,
  GROUP_MIME_TYPE,
} from "../../data/group-record.js";
import type { DataRecord } from "@starkeep/core";

async function sha256Hex(data: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

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

    // Step 1: create the group record (no file yet — we need its ID for the stable path)
    const prelimRecord = createGroupRecord(payload, null, null, null, context.clock, context.ownerId);

    // Step 2: build and write the .tdg file using the record's ID
    const fileContent: TdgFileContent = { ...payload, orderedTaskIds: [] };
    const fileBytes = encodeTdgFile(fileContent);
    const contentHash = await sha256Hex(fileBytes);
    const key = groupObjectStorageKey(prelimRecord.id);
    await context.objectStorageAdapter.put(key, fileBytes, { contentType: GROUP_MIME_TYPE });

    // Step 3: put the final record with file reference
    const finalRecord: DataRecord = {
      ...prelimRecord,
      objectStorageKey: key,
      contentHash,
      sizeBytes: fileBytes.length,
    };
    await context.databaseAdapter.put(finalRecord);

    const group = groupRecordToGroup(finalRecord, fileContent);
    return { status: 201, body: { group } };
  },
};
