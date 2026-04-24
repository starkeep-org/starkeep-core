import type { DatabaseAdapter } from "../../packages/storage-adapter/src/database/adapter.js";
import type { MetadataSyncRecord } from "../../packages/storage-adapter/src/database/types.js";
import type { HLCTimestamp } from "../../packages/core/src/hlc/types.js";

/**
 * Minimal DatabaseAdapter stub used only for metadata sync.
 * Implements the two methods called by the sync engine's pullMetadata / pushMetadata:
 *   - getSyncableMetadataChangesSince → GET {cloudUrl}/sync/metadata?since=<hlc>
 *   - upsertSyncableMetadata        → POST {cloudUrl}/data/metadata
 *
 * All other DatabaseAdapter methods throw because they are unreachable from the
 * metadata sync code paths (pullMetadata / pushMetadata only call these two).
 */
export class HttpRemoteMetadataAdapter {
  constructor(
    private readonly cloudUrl: string,
    private readonly getAuthHeader: () => string | undefined,
  ) {}

  private authHeaders(): Record<string, string> {
    const auth = this.getAuthHeader();
    return auth ? { Authorization: auth } : {};
  }

  async getSyncableMetadataChangesSince(since: HLCTimestamp): Promise<MetadataSyncRecord[]> {
    const encoded = encodeURIComponent(JSON.stringify(since));
    const res = await fetch(`${this.cloudUrl}/sync/metadata?since=${encoded}`, {
      headers: this.authHeaders(),
    });
    if (!res.ok) {
      throw new Error(`GET /sync/metadata failed: ${res.status} ${res.statusText}`);
    }
    const body = await res.json() as { records: MetadataSyncRecord[] };
    return body.records;
  }

  async upsertSyncableMetadata(record: MetadataSyncRecord): Promise<void> {
    const res = await fetch(`${this.cloudUrl}/data/metadata`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.authHeaders() },
      body: JSON.stringify({
        targetId: record.targetId,
        targetType: record.targetType,
        generatorId: record.generatorId,
        generatorVersion: record.generatorVersion,
        value: record.value,
        objectStorageKey: record.objectStorageKey ?? null,
        contentHash: record.contentHash ?? null,
        mimeType: record.mimeType ?? null,
        sizeBytes: record.sizeBytes ?? null,
      }),
    });
    if (!res.ok) {
      throw new Error(`POST /data/metadata failed: ${res.status} ${res.statusText}`);
    }
  }
}

// Cast helper — only the two methods above are ever called by the sync engine
// when used as remoteDatabaseAdapter.
export function asRemoteDatabaseAdapter(adapter: HttpRemoteMetadataAdapter): DatabaseAdapter {
  return adapter as unknown as DatabaseAdapter;
}
