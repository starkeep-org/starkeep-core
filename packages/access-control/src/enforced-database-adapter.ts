import type { AnyRecord, StarkeepId } from "@starkeep/core";
import type {
  DatabaseAdapter,
  Query,
  QueryResult,
  BatchOperation,
  Migration,
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

  async function assertAccess(resourceId: StarkeepId, permission: "read" | "write" | "delete"): Promise<void> {
    const result = await accessControlEngine.checkAccess({
      subjectType,
      subjectId,
      resourceId,
      permission,
    });

    if (!result.allowed) {
      throw new AccessDeniedError(
        `Access denied: ${permission} on ${resourceId} for ${subjectType}:${subjectId}`,
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

  async function get(id: StarkeepId): Promise<AnyRecord | null> {
    await assertAccess(id, "read");
    return databaseAdapter.get(id);
  }

  async function put(record: AnyRecord): Promise<void> {
    await assertAccess(record.id, "write");
    return databaseAdapter.put(record);
  }

  async function deleteRecord(id: StarkeepId): Promise<void> {
    await assertAccess(id, "delete");
    return databaseAdapter.delete(id);
  }

  async function query(queryInput: Query): Promise<QueryResult> {
    const result = await databaseAdapter.query(queryInput);
    const accessibleRecords: AnyRecord[] = [];

    for (const record of result.records) {
      const accessResult = await accessControlEngine.checkAccess({
        subjectType,
        subjectId,
        resourceId: record.id,
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

  async function runMigrations(migrations: Migration[]): Promise<void> {
    return databaseAdapter.runMigrations(migrations);
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
    runMigrations,
  };
}
