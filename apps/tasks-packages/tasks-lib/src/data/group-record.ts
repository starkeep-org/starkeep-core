import { createDataRecord, serializeHLC, type DataRecord, type HLCClock } from "@starkeep/core";
import type { TaskGroupPayload, TaskGroup, TdgFileContent } from "../types/group.js";

export const GROUP_RECORD_TYPE = "tasks:group";
export const GROUP_MIME_TYPE = "application/json";

export function groupObjectStorageKey(groupId: string): string {
  return `groups/${groupId}.tdg`;
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function encodeTdgFile(content: TdgFileContent): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(content));
}

export function decodeTdgFile(bytes: Uint8Array): TdgFileContent {
  return JSON.parse(new TextDecoder().decode(bytes)) as TdgFileContent;
}

/** Load the TdgFileContent from object storage for a group DataRecord. */
export async function loadTdgFile(
  record: DataRecord,
  objectStorageAdapter: {
    get: (key: string) => Promise<{ data: Uint8Array | ArrayBuffer } | null>;
  },
): Promise<TdgFileContent | null> {
  if (!record.objectStorageKey) return null;
  const result = await objectStorageAdapter.get(record.objectStorageKey);
  if (!result) return null;
  return decodeTdgFile(
    result.data instanceof Uint8Array
      ? result.data
      : new Uint8Array(result.data as ArrayBuffer),
  );
}

/**
 * Write updated TdgFileContent to object storage and return the updated DataRecord.
 * The objectStorageKey is stable (overwrite in place); only contentHash changes.
 * Does NOT put to DB — caller is responsible for that.
 */
export async function writeTdgFile(
  record: DataRecord,
  newContent: TdgFileContent,
  objectStorageAdapter: {
    put: (key: string, data: Uint8Array, options: { contentType: string }) => Promise<void>;
  },
  clock: HLCClock,
): Promise<{ updatedRecord: DataRecord; fileBytes: Uint8Array }> {
  const fileBytes = encodeTdgFile(newContent);
  const contentHash = await sha256Hex(fileBytes);
  const key = record.objectStorageKey ?? groupObjectStorageKey(record.id);
  await objectStorageAdapter.put(key, fileBytes, { contentType: GROUP_MIME_TYPE });
  const updatedRecord: DataRecord = {
    ...record,
    contentHash,
    objectStorageKey: key,
    sizeBytes: fileBytes.length,
    updatedAt: clock.now(),
  };
  return { updatedRecord, fileBytes };
}

export function createGroupRecord(
  payload: TaskGroupPayload,
  objectStorageKey: string | null,
  contentHash: string | null,
  fileBytes: Uint8Array | null,
  clock: HLCClock,
  ownerId: string,
): DataRecord {
  return createDataRecord(
    {
      type: GROUP_RECORD_TYPE,
      ownerId,
      payload: payload as unknown as Record<string, unknown>,
      ...(objectStorageKey != null ? { objectStorageKey } : {}),
      ...(contentHash != null ? { contentHash } : {}),
      ...(fileBytes != null ? { mimeType: GROUP_MIME_TYPE, sizeBytes: fileBytes.length } : {}),
    },
    clock,
  );
}

export function groupRecordToGroup(record: DataRecord, fileContent: TdgFileContent): TaskGroup {
  return {
    id: record.id,
    payload: record.payload as unknown as TaskGroupPayload,
    orderedTaskIds: fileContent.orderedTaskIds,
    createdAt: serializeHLC(record.createdAt),
    updatedAt: serializeHLC(record.updatedAt),
  };
}
