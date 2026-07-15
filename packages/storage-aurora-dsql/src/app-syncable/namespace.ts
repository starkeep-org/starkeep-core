import type {
  AppSyncableNamespace,
  AppSyncableTableInfo,
  AppSyncableNamespaceStore,
} from "@starkeep/sync-engine";
import type { DatabaseClient } from "../types.js";
import { compiler as qb } from "../query-builder.js";

/**
 * DSQL-backed implementation of `AppSyncableNamespaceStore`.
 * Reads `shared.app_syncable_namespaces` which is populated by `runAppInstallDdl`.
 */
export class DsqlAppSyncableNamespaceStore implements AppSyncableNamespaceStore {
  private cache: Map<string, AppSyncableNamespace> | null = null;

  constructor(private readonly client: DatabaseClient) {}

  get(appId: string): AppSyncableNamespace | null {
    return this.getCache().get(appId) ?? null;
  }

  list(): AppSyncableNamespace[] {
    return Array.from(this.getCache().values());
  }

  /** Force a re-read from DSQL (call after an install/uninstall). */
  invalidate(): void {
    this.cache = null;
  }

  private getCache(): Map<string, AppSyncableNamespace> {
    if (!this.cache) {
      throw new Error(
        "DsqlAppSyncableNamespaceStore: load() must be called before get/list",
      );
    }
    return this.cache;
  }

  async load(): Promise<void> {
    const query = qb
      .selectFrom("shared.app_syncable_namespaces")
      .select(["app_id", "tables_json", "files_enabled"])
      .compile();
    const result = await this.client.query(query.sql, [...query.parameters]);
    this.cache = new Map();
    for (const row of result.rows) {
      const tables: AppSyncableTableInfo[] = JSON.parse(row["tables_json"] as string);
      const ns: AppSyncableNamespace = {
        appId: row["app_id"] as string,
        tables,
        filesEnabled: Boolean(row["files_enabled"]),
        tableNames: tables.map((t) => t.name),
      };
      this.cache.set(ns.appId, ns);
    }
  }
}
