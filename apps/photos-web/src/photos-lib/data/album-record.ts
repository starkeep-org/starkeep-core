import { createDataRecord, serializeHLC, type DataRecord, type HLCClock } from "@starkeep/core";
import type { AlbumFileContent, AppAlbum } from "../types/album";
import { ALBUM_RECORD_TYPE } from "../manifest";

export { ALBUM_RECORD_TYPE };
export const ALBUM_MIME_TYPE = "application/json";

export function albumObjectStorageKey(albumId: string): string {
  return `albums/${albumId}.pal`;
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function encodePalFile(content: AlbumFileContent): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(content));
}

export function decodePalFile(bytes: Uint8Array): AlbumFileContent {
  return JSON.parse(new TextDecoder().decode(bytes)) as AlbumFileContent;
}

export async function loadPalFile(
  record: DataRecord,
  objectStorageAdapter: {
    get: (key: string) => Promise<{ data: Uint8Array | ArrayBuffer } | null>;
  },
): Promise<AlbumFileContent | null> {
  if (!record.objectStorageKey) return null;
  const result = await objectStorageAdapter.get(record.objectStorageKey);
  if (!result) return null;
  return decodePalFile(
    result.data instanceof Uint8Array
      ? result.data
      : new Uint8Array(result.data as ArrayBuffer),
  );
}

export async function writePalFile(
  record: DataRecord,
  newContent: AlbumFileContent,
  objectStorageAdapter: {
    put: (key: string, data: Uint8Array, options: { contentType: string }) => Promise<void>;
  },
  clock: HLCClock,
): Promise<{ updatedRecord: DataRecord; fileBytes: Uint8Array }> {
  const fileBytes = encodePalFile(newContent);
  const contentHash = await sha256Hex(fileBytes);
  const key = record.objectStorageKey ?? albumObjectStorageKey(record.id);
  await objectStorageAdapter.put(key, fileBytes, { contentType: ALBUM_MIME_TYPE });
  const updatedRecord: DataRecord = {
    ...record,
    contentHash,
    objectStorageKey: key,
    sizeBytes: fileBytes.length,
    updatedAt: clock.now(),
  };
  return { updatedRecord, fileBytes };
}

export async function createAlbumRecord(
  content: AlbumFileContent,
  clock: HLCClock,
  ownerId: string,
  objectStorageAdapter: {
    put: (key: string, data: Uint8Array, options: { contentType: string }) => Promise<void>;
  },
): Promise<{ record: DataRecord; fileBytes: Uint8Array }> {
  const record = createDataRecord(
    { type: ALBUM_RECORD_TYPE, ownerId, content: { name: content.name } },
    clock,
  );
  const fileBytes = encodePalFile(content);
  const contentHash = await sha256Hex(fileBytes);
  const key = albumObjectStorageKey(record.id);
  await objectStorageAdapter.put(key, fileBytes, { contentType: ALBUM_MIME_TYPE });
  const finalRecord: DataRecord = {
    ...record,
    objectStorageKey: key,
    contentHash,
    mimeType: ALBUM_MIME_TYPE,
    sizeBytes: fileBytes.length,
  };
  return { record: finalRecord, fileBytes };
}

export function albumRecordToAppAlbum(record: DataRecord, content: AlbumFileContent): AppAlbum {
  return {
    id: record.id,
    name: content.name,
    description: content.description,
    coverImageId: content.coverImageId,
    orderedImageIds: content.orderedImageIds,
    createdAt: serializeHLC(record.createdAt),
    updatedAt: serializeHLC(record.updatedAt),
  };
}
