import type { DatabaseSync } from "node:sqlite";
import type { ObjectStorageAdapter } from "@starkeep/storage-adapter";
import { appSyncableObjectKey } from "@starkeep/core";
import type {
  AppSpecificOperations,
  ApiSubject,
} from "@starkeep/shared-space-api";
import { appSyncableTableName, getAppSyncableNamespace } from "./namespace.js";

export interface AppSpecificFactoryOptions {
  db: DatabaseSync;
  storage: ObjectStorageAdapter;
  /**
   * Builds a URL the caller can hand back to a browser to fetch the file.
   * Optional — when omitted, `fileUrl()` returns null. The local-data-server
   * supplies its signed-token URL builder here.
   */
  buildFileUrl?: (key: string, mimeType: string, expiresIn: number) => string;
}

/**
 * Builds the per-request `appSpecific` view. The returned factory is shaped to
 * plug directly into `createSharedSpaceApi({ getAppSpecific })`. It looks up
 * the calling app's syncable namespace and refuses ops against tables the app
 * did not declare or file ops when the app didn't opt in to files.
 */
export function createAppSpecificFactory(
  options: AppSpecificFactoryOptions,
): (subject: ApiSubject) => AppSpecificOperations | null {
  const { db, storage, buildFileUrl } = options;
  return (subject) => {
    if (subject.subjectType !== "app") return null;
    const appId = subject.subjectId;
    const ns = getAppSyncableNamespace(db, appId);
    if (!ns) return null;
    const declaredTables = new Set(ns.tableNames);

    function resolveTable(table: string): string {
      if (!declaredTables.has(table)) {
        throw new Error(
          `App "${appId}" did not declare app-syncable table "${table}"`,
        );
      }
      return appSyncableTableName(appId, table);
    }

    function quoteIdent(name: string): string {
      if (!/^[a-z_][a-z0-9_]*$/i.test(name)) {
        throw new Error(`Invalid identifier: ${JSON.stringify(name)}`);
      }
      return `"${name}"`;
    }

    function ensureFilesEnabled(): void {
      if (!ns!.filesEnabled) {
        throw new Error(`App "${appId}" did not opt in to syncable files`);
      }
    }

    return {
      async insertRow(table, row) {
        const fullName = resolveTable(table);
        const cols = Object.keys(row);
        if (cols.length === 0) throw new Error("insertRow: row must have at least one column");
        const placeholders = cols.map(() => "?").join(", ");
        const sql = `INSERT INTO "${fullName}" (${cols.map(quoteIdent).join(", ")}) VALUES (${placeholders})`;
        db.prepare(sql).run(...(cols.map((c) => row[c] as never)));
      },

      async updateRow(table, where, patch) {
        const fullName = resolveTable(table);
        const patchCols = Object.keys(patch);
        const whereCols = Object.keys(where);
        if (patchCols.length === 0) throw new Error("updateRow: patch must have at least one column");
        const setSql = patchCols.map((c) => `${quoteIdent(c)} = ?`).join(", ");
        const whereSql = whereCols.length
          ? "WHERE " + whereCols.map((c) => `${quoteIdent(c)} = ?`).join(" AND ")
          : "";
        const sql = `UPDATE "${fullName}" SET ${setSql} ${whereSql}`.trim();
        const params = [...patchCols.map((c) => patch[c]), ...whereCols.map((c) => where[c])];
        const result = db.prepare(sql).run(...(params as never[]));
        return Number(result.changes ?? 0);
      },

      async deleteRow(table, where) {
        const fullName = resolveTable(table);
        const whereCols = Object.keys(where);
        const whereSql = whereCols.length
          ? "WHERE " + whereCols.map((c) => `${quoteIdent(c)} = ?`).join(" AND ")
          : "";
        const sql = `DELETE FROM "${fullName}" ${whereSql}`.trim();
        const result = db
          .prepare(sql)
          .run(...(whereCols.map((c) => where[c]) as never[]));
        return Number(result.changes ?? 0);
      },

      async queryRows(table, where) {
        const fullName = resolveTable(table);
        const whereCols = where ? Object.keys(where) : [];
        const whereSql = whereCols.length
          ? "WHERE " + whereCols.map((c) => `${quoteIdent(c)} = ?`).join(" AND ")
          : "";
        const sql = `SELECT * FROM "${fullName}" ${whereSql}`.trim();
        const rows = db
          .prepare(sql)
          .all(...(whereCols.map((c) => where![c]) as never[])) as Record<string, unknown>[];
        return rows;
      },

      async putFile(subKey, bytes, mimeType) {
        ensureFilesEnabled();
        const key = appSyncableObjectKey(appId, subKey);
        await storage.put(key, bytes, { contentType: mimeType });
        return { key };
      },

      async getFile(subKey) {
        ensureFilesEnabled();
        const key = appSyncableObjectKey(appId, subKey);
        const result = await storage.get(key);
        if (!result) return null;
        const data =
          result.data instanceof Uint8Array
            ? result.data
            : new Uint8Array(result.data as ArrayBuffer);
        return { bytes: data, mimeType: result.contentType ?? "application/octet-stream" };
      },

      async deleteFile(subKey) {
        ensureFilesEnabled();
        const key = appSyncableObjectKey(appId, subKey);
        await storage.delete(key);
      },

      async fileUrl(subKey, opts) {
        ensureFilesEnabled();
        const key = appSyncableObjectKey(appId, subKey);
        const result = await storage.get(key);
        if (!result) return null;
        const mimeType = result.contentType ?? "application/octet-stream";
        const expiresIn = opts?.expiresIn ?? 3600;
        return buildFileUrl ? buildFileUrl(key, mimeType, expiresIn) : null;
      },
    };
  };
}
