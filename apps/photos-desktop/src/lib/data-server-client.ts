/**
 * HTTP client for the local Starkeep data-server (http://127.0.0.1:9820).
 *
 * The photos app is a thin client: it delegates all storage operations to the
 * data-server so that records end up in the shared ~/.starkeep database, making
 * them visible to the file-provider and other Starkeep apps.
 *
 * App-side generators (EXIF, provenance, user-authored) run locally in the
 * webview and push their results via postMetadata().
 */

const DATA_SERVER_URL = "http://127.0.0.1:9820";

export interface PhotoRecord {
  id: string;
  type: string;
  mime_type: string | null;
  size_bytes: number | null;
  created_at: string;
  updated_at: string;
  owner_id: string;
  sync_status: string;
  payload: {
    fileName?: string;
    title?: string;
    [k: string]: unknown;
  };
  content_hash: string | null;
  object_storage_key: string | null;
  original_filename: string | null;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${DATA_SERVER_URL}${path}`, options);
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.json() as { error?: string };
      if (body.error) message = body.error;
    } catch {}
    throw new Error(`Data server ${options?.method ?? "GET"} ${path} → ${res.status}: ${message}`);
  }
  return res.json() as Promise<T>;
}

/**
 * Register a @starkeep/image record from a local file path.
 * The server creates a symlink in ~/.starkeep/objects/ pointing to the
 * original file — no bytes are copied.
 */
export async function addPhotoFromPath(
  filePath: string,
  mimeType: string,
  fileName: string,
  title: string,
): Promise<PhotoRecord> {
  const result = await request<{ record: PhotoRecord }>("/data/records", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "@starkeep/image",
      payload: { fileName, title },
      fileName,
      contentType: mimeType,
      filePath,
    }),
  });
  return result.record;
}

/** Fetch all @starkeep/image records from the data-server, newest first. */
export async function listPhotos(): Promise<PhotoRecord[]> {
  const result = await request<{ records: PhotoRecord[] }>(
    "/data/records?type=%40starkeep%2Fimage&limit=500",
  );
  return result.records;
}

/**
 * Get a short-lived signed URL for downloading a record's file.
 * The URL is served directly by the data-server (no S3 required for local-only).
 */
export async function getPhotoFileUrl(id: string): Promise<string> {
  const result = await request<{ url: string }>(`/data/records/${id}/file-url`);
  return result.url;
}

export interface FileRef {
  key: string;
  contentHash: string;
  mimeType: string;
  sizeBytes: number;
}

/**
 * Upload raw bytes to the data-server's content-addressed file store.
 * Returns a file reference that can be passed to postMetadata().
 * Separate from metadata registration so each concern is independent.
 */
export async function uploadFile(bytes: Uint8Array, mimeType: string): Promise<FileRef> {
  return request<FileRef>("/data/files", {
    method: "POST",
    headers: { "Content-Type": mimeType },
    body: bytes,
  });
}

/**
 * Push the result of an app-side generator to the data-server.
 * The server stores it in the shared metadata_sync table so it can be
 * read back when assembling the full image record.
 * Pass a fileRef (from uploadFile) when the generator produced a file.
 */
export async function postMetadata(
  targetId: string,
  targetType: string,
  generatorId: string,
  generatorVersion: number,
  value: Record<string, unknown>,
  fileRef?: FileRef,
): Promise<void> {
  await request<{ ok: true }>("/data/metadata", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      targetId,
      targetType,
      generatorId,
      generatorVersion,
      value,
      ...(fileRef && {
        objectStorageKey: fileRef.key,
        contentHash: fileRef.contentHash,
        mimeType: fileRef.mimeType,
        sizeBytes: fileRef.sizeBytes,
      }),
    }),
  });
}

/**
 * Get a time-limited signed URL for a metadata-backed file (e.g. a downsize thumbnail).
 * Returns null if no file-backed metadata exists for this record + generator combination.
 */
export async function getMetadataFileUrl(
  targetId: string,
  generatorId: string,
): Promise<string | null> {
  const encodedGeneratorId = encodeURIComponent(generatorId);
  try {
    const result = await request<{ url: string }>(
      `/data/metadata/${targetId}/${encodedGeneratorId}/file-url`,
    );
    return result.url;
  } catch {
    return null;
  }
}

