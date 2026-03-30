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

/** Normalize an app ID to its private-type prefix form.
 *  "@starkeep/photos" → "starkeep-photos" */
function normalizeAppId(appId: string): string {
  return appId.replace(/^@/, "").replace(/\//g, "-");
}

/** If `type` matches `<prefix>:private:<subtype>`, return `prefix`; otherwise `null`. */
function getPrivateTypeOwner(type: string): string | null {
  const idx = type.indexOf(":private:");
  if (idx === -1) return null;
  return type.slice(0, idx);
}

export function createEnforcedDatabaseAdapter(options: {
  databaseAdapter: DatabaseAdapter;
  accessControlEngine: AccessControlEngine;
  subjectType: SubjectType;
  subjectId: string;
}): EnforcedDatabaseAdapter {
  const { databaseAdapter, accessControlEngine, subjectType, subjectId } = options;
  const normalizedSubject = normalizeAppId(subjectId);

  /**
   * Enforce access for a record whose type is already known.
   *
   * Private-storage rule (structural, not policy-based):
   *   - Own private type  → allowed without a policy.
   *   - Other app's private type → denied regardless of policies.
   *
   * All other types → policy-based check via the access-control engine.
   */
  async function assertTypeAccess(
    recordType: string,
    recordId: StarkeepId,
    permission: "read" | "write" | "delete",
  ): Promise<void> {
    const privateOwner = getPrivateTypeOwner(recordType);
    if (privateOwner !== null) {
      if (normalizedSubject === privateOwner) {
        // Own private type — structurally allowed.
        return;
      }
      throw new AccessDeniedError(
        `Access denied: ${permission} on private type ${recordType} for ${subjectType}:${subjectId}`,
      );
    }

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

  async function get(id: StarkeepId): Promise<AnyRecord | null> {
    const record = await databaseAdapter.get(id);
    if (!record) return null;
    await assertTypeAccess(record.type, record.id, "read");
    return record;
  }

  async function put(record: AnyRecord): Promise<void> {
    await assertTypeAccess(record.type, record.id, "write");
    return databaseAdapter.put(record);
  }

  async function deleteRecord(id: StarkeepId): Promise<void> {
    const record = await databaseAdapter.get(id);
    if (!record) return;
    await assertTypeAccess(record.type, record.id, "delete");
    return databaseAdapter.delete(id);
  }

  async function query(queryInput: Query): Promise<QueryResult> {
    const result = await databaseAdapter.query(queryInput);
    const accessibleRecords: AnyRecord[] = [];

    for (const record of result.records) {
      const privateOwner = getPrivateTypeOwner(record.type);
      if (privateOwner !== null) {
        if (normalizedSubject === privateOwner) {
          accessibleRecords.push(record);
        }
        // Other app's private records are silently excluded.
        continue;
      }

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
