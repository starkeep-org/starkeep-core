const DATA_SERVER_URL = "http://127.0.0.1:9820";

export interface DataRecord {
  id: string;
  kind: string;
  type: string;
  created_at: string;
  updated_at: string;
  owner_id: string;
  sync_status: string;
  version: number;
  payload: Record<string, unknown> | null;
  content_hash: string | null;
  object_storage_key: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  path: string | null;
}

export interface Watch {
  id: string;
  directoryPath: string;
  targetType: string;
  syncedFiles: number;
  totalFiles: number;
  status: string;
}

export interface WatchFile {
  relativePath: string;
  dataRecordId: string | null;
  contentHash: string | null;
  syncStatus: string;
}

export interface MetadataEntry {
  generatorId: string;
  generatorVersion: number;
  value: Record<string, unknown>;
  updatedAt: string;
}

async function request<T>(path: string): Promise<T> {
  const res = await fetch(`${DATA_SERVER_URL}${path}`);
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.json() as { error?: string };
      if (body.error) message = body.error;
    } catch { /* empty */ }
    throw new Error(`GET ${path} → ${res.status}: ${message}`);
  }
  return res.json() as Promise<T>;
}

export async function listRecords(limit = 1000): Promise<DataRecord[]> {
  const result = await request<{ records: DataRecord[] }>(
    `/data/records?limit=${limit}`,
  );
  return result.records;
}

export async function listWatches(): Promise<Watch[]> {
  const result = await request<{ watches: Watch[] }>("/watches");
  return result.watches;
}

export async function listWatchFiles(watchId: string): Promise<WatchFile[]> {
  const result = await request<{ files: WatchFile[] }>(`/watches/${watchId}/files`);
  return result.files;
}

export async function getRecordMetadata(id: string): Promise<MetadataEntry[]> {
  const result = await request<{ metadata: MetadataEntry[] }>(
    `/data/records/${id}/metadata`,
  );
  return result.metadata;
}
