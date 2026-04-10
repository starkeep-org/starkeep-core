import type { DataRecord, MetadataRecord, StarkeepId } from "@starkeep/core";
import type { DatabaseAdapter } from "../database/adapter.js";
import type {
  Query,
  QueryResult,
  BatchOperation,
  Migration,
  Transaction,
  MetadataColumnDefinition,
  MetadataQuery,
  MetadataQueryResult,
} from "../database/types.js";

export class MockDatabaseAdapter implements DatabaseAdapter {
  private store = new Map<string, DataRecord>();
  /** metadata[targetType][targetId][generatorId] = MetadataRecord */
  private metadata = new Map<string, Map<string, Map<string, MetadataRecord>>>();
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

  async delete(id: StarkeepId): Promise<void> {
    this.store.delete(id);
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
        await this.delete(operation.id);
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

  async runMigrations(_migrations: Migration[]): Promise<void> {
    // No-op for mock
  }

  async ensureMetadataTable(
    _targetType: string,
    _generatorId: string,
    _columns: MetadataColumnDefinition[],
  ): Promise<void> {
    // No-op: in-memory store doesn't need DDL
  }

  async putMetadata(targetType: string, entry: MetadataRecord): Promise<void> {
    let byType = this.metadata.get(targetType);
    if (!byType) {
      byType = new Map();
      this.metadata.set(targetType, byType);
    }
    let byTarget = byType.get(entry.targetId);
    if (!byTarget) {
      byTarget = new Map();
      byType.set(entry.targetId, byTarget);
    }
    byTarget.set(entry.generatorId, structuredClone(entry));
  }

  async queryMetadata(targetType: string, query: MetadataQuery): Promise<MetadataQueryResult> {
    const byType = this.metadata.get(targetType);
    if (!byType) return { entries: [] };

    const entries: MetadataRecord[] = [];

    const filterEntry = (entry: MetadataRecord): boolean => {
      if (!query.filters) return true;
      for (const filter of query.filters) {
        const value = entry.value[filter.field];
        switch (filter.operator) {
          case "eq": if (value !== filter.value) return false; break;
          case "neq": if (value === filter.value) return false; break;
          case "gt": if ((value as number) <= (filter.value as number)) return false; break;
          case "gte": if ((value as number) < (filter.value as number)) return false; break;
          case "lt": if ((value as number) >= (filter.value as number)) return false; break;
          case "lte": if ((value as number) > (filter.value as number)) return false; break;
          case "in": if (!(filter.value as unknown[]).includes(value)) return false; break;
          case "like": if (typeof value !== "string" || !value.includes(filter.value as string)) return false; break;
        }
      }
      return true;
    };

    const collectEntries = (byTarget: Map<string, MetadataRecord>): void => {
      for (const entry of byTarget.values()) {
        if (query.generatorId && entry.generatorId !== query.generatorId) continue;
        if (filterEntry(entry)) entries.push(structuredClone(entry));
      }
    };

    if (query.targetId) {
      const byTarget = byType.get(query.targetId);
      if (byTarget) collectEntries(byTarget);
    } else if (query.targetIds && query.targetIds.length > 0) {
      for (const targetId of query.targetIds) {
        const byTarget = byType.get(targetId);
        if (byTarget) collectEntries(byTarget);
      }
    } else {
      for (const byTarget of byType.values()) {
        collectEntries(byTarget);
      }
    }

    return { entries };
  }

  get size(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
    this.metadata.clear();
  }
}
