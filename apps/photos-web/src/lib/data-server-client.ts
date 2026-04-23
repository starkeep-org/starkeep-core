import { resolveDataSource, type DataSourceMode } from "./data-client";

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

async function request<T>(
  path: string,
  source: { baseUrl: string; headers: Record<string, string> },
  options?: RequestInit,
): Promise<T> {
  const method = options?.method ?? "GET";
  const url = `${source.baseUrl}${path}`;
  const hasAuth = !!source.headers["Authorization"];
  console.debug(`[data-server-client] ${method} ${url} (auth: ${hasAuth})`);

  let res: Response;
  try {
    res = await fetch(url, {
      ...options,
      headers: { ...source.headers, ...options?.headers },
    });
  } catch (err) {
    console.error(`[data-server-client] ${method} ${url} — network error:`, err);
    throw err;
  }

  console.debug(`[data-server-client] ${method} ${url} → ${res.status}`);
  if (!res.ok) {
    let message = res.statusText;
    let rawBody = "";
    try {
      rawBody = await res.text();
      const parsed = JSON.parse(rawBody) as { error?: string };
      if (parsed.error) message = parsed.error;
    } catch {}
    console.error(`[data-server-client] ${method} ${url} → ${res.status}:`, message, rawBody ? `(body: ${rawBody.slice(0, 500)})` : "");
    throw new Error(`Data server ${method} ${path} → ${res.status}: ${message}`);
  }
  return res.json() as Promise<T>;
}

/**
 * Register a @starkeep/image record.
 *
 * Local mode: sends filePath — server creates a symlink, no bytes transferred.
 * Remote mode: sends fileBase64 — server uploads bytes to S3.
 */
export async function addPhotoFromPath(
  filePath: string,
  fileBytes: Uint8Array,
  mimeType: string,
  fileName: string,
  title: string,
  mode: DataSourceMode,
): Promise<PhotoRecord> {
  const source = await resolveDataSource(mode);

  let body: Record<string, unknown>;
  if (mode === "remote") {
    console.debug(`[data-server-client] Encoding ${fileBytes.length} bytes to base64 for remote upload`);
    let binary = "";
    const chunkSize = 8192;
    for (let i = 0; i < fileBytes.length; i += chunkSize) {
      binary += String.fromCharCode(...fileBytes.subarray(i, i + chunkSize));
    }
    const fileBase64 = btoa(binary);
    console.debug(`[data-server-client] base64 length: ${fileBase64.length} chars (~${(fileBase64.length / 1024 / 1024).toFixed(1)} MB)`);
    body = {
      type: "@starkeep/image",
      payload: { fileName, title },
      fileName,
      contentType: mimeType,
      fileBase64,
    };
  } else {
    console.debug(`[data-server-client] Local upload via filePath: ${filePath}`);
    body = {
      type: "@starkeep/image",
      payload: { fileName, title },
      fileName,
      contentType: mimeType,
      filePath,
    };
  }

  const result = await request<{ record: PhotoRecord }>("/data/records", source, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return result.record;
}

export async function listPhotos(mode: DataSourceMode): Promise<PhotoRecord[]> {
  const source = await resolveDataSource(mode);
  const result = await request<{ records: PhotoRecord[] }>(
    "/data/records?type=%40starkeep%2Fimage&limit=500",
    source,
  );
  return result.records;
}

export async function getPhotoFileUrl(id: string, mode: DataSourceMode): Promise<string> {
  const source = await resolveDataSource(mode);
  const result = await request<{ url: string }>(`/data/records/${id}/file-url`, source);
  return result.url;
}

export interface FileRef {
  key: string;
  contentHash: string;
  mimeType: string;
  sizeBytes: number;
}

export async function uploadFile(bytes: Uint8Array, mimeType: string, mode: DataSourceMode): Promise<FileRef> {
  const source = await resolveDataSource(mode);
  return request<FileRef>("/data/files", source, {
    method: "POST",
    headers: { "Content-Type": mimeType },
    body: bytes as unknown as BodyInit,
  });
}

export async function postMetadata(
  targetId: string,
  targetType: string,
  generatorId: string,
  generatorVersion: number,
  value: Record<string, unknown>,
  mode: DataSourceMode,
  fileRef?: FileRef,
): Promise<void> {
  const source = await resolveDataSource(mode);
  await request<{ ok: true }>("/data/metadata", source, {
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

export async function getMetadataFileUrl(
  targetId: string,
  generatorId: string,
  mode: DataSourceMode,
): Promise<string | null> {
  const source = await resolveDataSource(mode);
  const encodedGeneratorId = encodeURIComponent(generatorId);
  try {
    const result = await request<{ url: string }>(
      `/data/metadata/${targetId}/${encodedGeneratorId}/file-url`,
      source,
    );
    return result.url;
  } catch {
    return null;
  }
}
