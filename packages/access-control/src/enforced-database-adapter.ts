import type { DataRecord, HLCTimestamp, MetadataRow, StarkeepId } from "@starkeep/core";
import type {
  DatabaseAdapter,
  Query,
  QueryResult,
  BatchOperation,
  Transaction,
} from "@starkeep/storage-adapter";
import type { AccessControlEngine, EnforcedDatabaseAdapter, SubjectType } from "./types.js";
import { AccessDeniedError } from "./errors.js";

export function createEnforcedDatabaseAdapter(options: {
  databaseAdapter: DatabaseAdapter;
  accessControlEngine: AccessControlEngine;
  subjectType: SubjectType;
  subjectId: string;
}): EnforcedDatabaseAdapter {
  const { databaseAdapter, accessControlEngine, subjectType, subjectId } = options;

  async function assertTypeAccess(
    recordType: string,
    recordId: StarkeepId,
    permission: "read" | "write" | "delete",
  ): Promise<void> {
    const result = await accessControlEngine.checkAccess({
      subjectType,
      subjectId,
      resourceId: recordId,
      recordType,
      permission,
    });

    if (!result.allowed) {
      throw new AccessDeniedError(
        `Access denied: ${permission} on ${recordType} for ${subjectType}:${subjectId}`,
      );
    }
  }

  async function init(): Promise<void> {
    return databaseAdapter.init();
  }

  async function close(): Promise<void> {
    return databaseAdapter.close();
  }

  async function healthCheck(): Promise<boolean> {
    return databaseAdapter.healthCheck();
  }

  async function get(id: StarkeepId): Promise<DataRecord | null> {
    const record = await databaseAdapter.get(id);
    if (!record) return null;
    await assertTypeAccess(record.type, record.id, "read");
    return record;
  }

  async function put(record: DataRecord): Promise<void> {
    await assertTypeAccess(record.type, record.id, "write");
    return databaseAdapter.put(record);
  }

  async function deleteRecord(id: StarkeepId, hlc: HLCTimestamp): Promise<void> {
    const record = await databaseAdapter.get(id);
    if (!record) return;
    await assertTypeAccess(record.type, record.id, "delete");
    return databaseAdapter.delete(id, hlc);
  }

  async function query(queryInput: Query): Promise<QueryResult> {
    const result = await databaseAdapter.query(queryInput);
    const accessibleRecords: DataRecord[] = [];

    for (const record of result.records) {
      const accessResult = await accessControlEngine.checkAccess({
        subjectType,
        subjectId,
        resourceId: record.id,
        recordType: record.type,
        permission: "read",
      });

      if (accessResult.allowed) {
        accessibleRecords.push(record);
      }
    }

    return {
      records: accessibleRecords,
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
    };
  }

  async function batch(operations: BatchOperation[]): Promise<void> {
    return databaseAdapter.batch(operations);
  }

  async function transaction<T>(callback: (transactionContext: Transaction) => Promise<T>): Promise<T> {
    return databaseAdapter.transaction(callback);
  }

  async function putMetadata(typeId: string, row: MetadataRow): Promise<void> {
    await assertTypeAccess(typeId, row.recordId, "write");
    return databaseAdapter.putMetadata(typeId, row);
  }

  async function getMetadata(typeId: string, recordId: StarkeepId): Promise<MetadataRow | null> {
    await assertTypeAccess(typeId, recordId, "read");
    return databaseAdapter.getMetadata(typeId, recordId);
  }

  async function getMetadataByIds(
    typeId: string,
    recordIds: StarkeepId[],
  ): Promise<Map<StarkeepId, MetadataRow>> {
    // Filter the result set by per-record access; cheaper than per-id pre-check.
    const all = await databaseAdapter.getMetadataByIds(typeId, recordIds);
    const accessible = new Map<StarkeepId, MetadataRow>();
    for (const [recordId, row] of all) {
      const result = await accessControlEngine.checkAccess({
        subjectType,
        subjectId,
        resourceId: recordId,
        recordType: typeId,
        permission: "read",
      });
      if (result.allowed) accessible.set(recordId, row);
    }
    return accessible;
  }

  async function deleteMetadata(typeId: string, recordId: StarkeepId): Promise<void> {
    await assertTypeAccess(typeId, recordId, "delete");
    return databaseAdapter.deleteMetadata(typeId, recordId);
  }

  return {
    init,
    close,
    healthCheck,
    get,
    put,
    delete: deleteRecord,
    query,
    batch,
    transaction,
    putMetadata,
    getMetadata,
    getMetadataByIds,
    deleteMetadata,
  };
}
