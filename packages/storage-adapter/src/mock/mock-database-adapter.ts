import type { DataRecord, HLCTimestamp, MetadataRow, StarkeepId } from "@starkeep/protocol-primitives";
import type { DatabaseAdapter } from "../database/adapter.js";
import type {
  Query,
  QueryResult,
  BatchOperation,
  Transaction,
} from "../database/types.js";

export class MockDatabaseAdapter implements DatabaseAdapter {
  private store = new Map<string, DataRecord>();
  private metadata = new Map<string, Map<string, MetadataRow>>();
  private initialized = false;

  async init(): Promise<void> {
    this.initialized = true;
  }

  async close(): Promise<void> {
    this.initialized = false;
  }

  async healthCheck(): Promise<boolean> {
    return this.initialized;
  }

  async put(record: DataRecord): Promise<void> {
    this.store.set(record.id, structuredClone(record));
  }

  async get(id: StarkeepId): Promise<DataRecord | null> {
    const record = this.store.get(id);
    return record ? structuredClone(record) : null;
  }

  async delete(id: StarkeepId, hlc: HLCTimestamp): Promise<void> {
    const existing = this.store.get(id);
    if (!existing) return;
    this.store.set(id, { ...existing, deletedAt: hlc, updatedAt: hlc });
  }

  async query(query: Query): Promise<QueryResult> {
    let records = Array.from(this.store.values());

    if (query.type) {
      records = records.filter((record) => record.type === query.type);
    }
    if (query.filters) {
      for (const filter of query.filters) {
        records = records.filter((record) => {
          const parts = filter.field.split(".");
          let value: unknown = record;
          for (const part of parts) {
            value = (value as Record<string, unknown>)?.[part];
          }
          switch (filter.operator) {
            case "eq": return value === filter.value;
            case "neq": return value !== filter.value;
            case "gt": return (value as number) > (filter.value as number);
            case "gte": return (value as number) >= (filter.value as number);
            case "lt": return (value as number) < (filter.value as number);
            case "lte": return (value as number) <= (filter.value as number);
            case "in": return (filter.value as unknown[]).includes(value);
            case "like": return typeof value === "string" && value.includes(filter.value as string);
            default: return true;
          }
        });
      }
    }
    if (query.sort) {
      records.sort((a, b) => {
        for (const sortField of query.sort!) {
          const aValue = (a as unknown as Record<string, unknown>)[sortField.field] as string | number;
          const bValue = (b as unknown as Record<string, unknown>)[sortField.field] as string | number;
          if (aValue < bValue) return sortField.direction === "asc" ? -1 : 1;
          if (aValue > bValue) return sortField.direction === "asc" ? 1 : -1;
        }
        return 0;
      });
    }

    const limit = query.limit ?? records.length;
    const cursorIndex = query.cursor
      ? records.findIndex((record) => record.id === query.cursor) + 1
      : 0;

    const sliced = records.slice(cursorIndex, cursorIndex + limit);
    const hasMore = cursorIndex + limit < records.length;

    return {
      records: sliced.map((record) => structuredClone(record)),
      nextCursor: hasMore ? sliced[sliced.length - 1].id : null,
      hasMore,
    };
  }

  async batch(operations: BatchOperation[]): Promise<void> {
    for (const operation of operations) {
      if (operation.type === "put") {
        await this.put(operation.record);
      } else {
        await this.delete(operation.id, operation.hlc);
      }
    }
  }

  async transaction<T>(callback: (transaction: Transaction) => Promise<T>): Promise<T> {
    const snapshot = new Map(this.store);
    try {
      const result = await callback(this as Transaction);
      return result;
    } catch (error) {
      this.store = snapshot;
      throw error;
    }
  }

  async putMetadata(typeId: string, row: MetadataRow): Promise<void> {
    let typeTable = this.metadata.get(typeId);
    if (!typeTable) {
      typeTable = new Map();
      this.metadata.set(typeId, typeTable);
    }
    typeTable.set(row.recordId, structuredClone(row));
  }

  async getMetadata(typeId: string, recordId: StarkeepId): Promise<MetadataRow | null> {
    const row = this.metadata.get(typeId)?.get(recordId);
    return row ? structuredClone(row) : null;
  }

  async getMetadataByIds(
    typeId: string,
    recordIds: StarkeepId[],
  ): Promise<Map<StarkeepId, MetadataRow>> {
    const table = this.metadata.get(typeId);
    const result = new Map<StarkeepId, MetadataRow>();
    if (!table) return result;
    for (const id of recordIds) {
      const row = table.get(id);
      if (row) result.set(id, structuredClone(row));
    }
    return result;
  }

  async deleteMetadata(typeId: string, recordId: StarkeepId): Promise<void> {
    this.metadata.get(typeId)?.delete(recordId);
  }

  get size(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
    this.metadata.clear();
  }
}
