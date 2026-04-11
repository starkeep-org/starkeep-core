import { createDataRecord, serializeHLC, type DataRecord, type HLCClock } from "@starkeep/core";
import type { TdoFileContent, Task } from "../types/task.js";

export const TASK_RECORD_TYPE = "todo:task";
export const TASK_MIME_TYPE = "application/json";

export function createTaskRecord(
  content: TdoFileContent,
  fileBytes: Uint8Array,
  objectStorageKey: string,
  contentHash: string,
  clock: HLCClock,
  ownerId: string,
): DataRecord {
  return createDataRecord(
    {
      type: TASK_RECORD_TYPE,
      ownerId,
      content: { groupId: content.groupId },
      contentHash,
      objectStorageKey,
      mimeType: TASK_MIME_TYPE,
      sizeBytes: fileBytes.length,
    },
    clock,
  );
}

export function taskRecordToTask(record: DataRecord, content: TdoFileContent): Task {
  return {
    id: record.id,
    groupId: content.groupId,
    title: content.title,
    description: content.description,
    assignee: content.assignee,
    status: content.status,
    blockers: content.blockers,
    labels: content.labels,
    comments: content.comments,
    createdAt: serializeHLC(record.createdAt),
    updatedAt: serializeHLC(record.updatedAt),
    objectStorageKey: record.objectStorageKey ?? "",
  };
}

export function encodeTdoFile(content: TdoFileContent): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(content));
}

export function decodeTdoFile(bytes: Uint8Array): TdoFileContent {
  return JSON.parse(new TextDecoder().decode(bytes)) as TdoFileContent;
}
