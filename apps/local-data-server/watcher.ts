/**
 * FileWatchManager — monitors local directories and syncs files to Starkeep.
 *
 * Each watched directory gets:
 * - A real data record per file (e.g., media:photo) with the file stored in object storage
 *
 * File tracking state (path ↔ record ID mapping) is stored in a private `watch_files`
 * SQLite table managed here — it never touches the user data layer.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { join, relative, extname, basename } from "node:path";
import { pipeline } from "node:stream/promises";
import type { DatabaseSync } from "node:sqlite";
import type { StarkeepSdk } from "../../packages/sdk/src/types.js";
import type { DatabaseAdapter } from "../../packages/storage-adapter/src/database/adapter.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WatchConfig {
  id: string;
  directoryPath: string;
  recursive: boolean;
  includePatterns?: string[];
  excludePatterns?: string[];
}

export interface WatchStatus {
  id: string;
  directoryPath: string;
  state: "scanning" | "watching" | "error" | "stopped";
  totalFiles: number;
  syncedFiles: number;
  lastScanAt: string | null;
  error?: string;
}

export interface WatchFileInfo {
  filePath: string;
  relativePath: string;
  contentHash: string;
  dataRecordId: string;
  mtime: number;
  status: "synced" | "pending" | "error";
}

export interface FileWatchManager {
  startWatch(config: WatchConfig): Promise<void>;
  stopWatch(watchId: string): Promise<void>;
  getStatus(watchId: string): WatchStatus | null;
  getAllStatuses(): WatchStatus[];
  getWatchFiles(watchId: string): WatchFileInfo[];
  getFileStatus(filePath: string): { watched: boolean; synced: boolean; watchId?: string; recordId?: string };
  getDirectoryStatus(dirPath: string): { watched: boolean; watchId?: string; directoryPath?: string };
  shutdown(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Identification
// ---------------------------------------------------------------------------

// The record's `type` is the lowercase file extension (no dot); "" for
// extension-less files. The category is derived downstream via
// `categoryOf(type)` — unmapped/empty extensions become the Drive-only
// "other" category. The watcher never skips: every file is ingested.
function extensionOf(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return ext.startsWith(".") ? ext.slice(1) : ext;
}

// Incidental MIME for the stored blob's Content-Type. Not authoritative and
// never decides the type. A small table covers common cases; everything else
// is the generic octet-stream.
const EXT_MIME: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
  gif: "image/gif", webp: "image/webp", heic: "image/heic",
  mp4: "video/mp4", mov: "video/quicktime", avi: "video/x-msvideo",
  mp3: "audio/mpeg", wav: "audio/wav", flac: "audio/flac",
  pdf: "application/pdf", txt: "text/plain", md: "text/markdown",
  json: "application/json", csv: "text/csv",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

function mimeFromExtension(ext: string): string {
  return EXT_MIME[ext] ?? "application/octet-stream";
}

// ---------------------------------------------------------------------------
// Streaming hash
// ---------------------------------------------------------------------------

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(filePath), hash);
  return hash.digest("hex");
}

// ---------------------------------------------------------------------------
// Pattern matching
// ---------------------------------------------------------------------------

function matchesPatterns(filename: string, patterns?: string[]): boolean {
  if (!patterns || patterns.length === 0) return true;
  return patterns.some((p) => {
    if (p.startsWith("*.")) return filename.endsWith(p.slice(1));
    return filename === p;
  });
}

function isExcluded(filename: string, patterns?: string[]): boolean {
  const defaults = [".DS_Store", "Thumbs.db", ".gitkeep"];
  const all = [...defaults, ...(patterns ?? [])];
  return all.some((p) => {
    if (p.startsWith("*.")) return filename.endsWith(p.slice(1));
    return filename === p;
  });
}

// ---------------------------------------------------------------------------
// ActiveWatch
// ---------------------------------------------------------------------------

interface ActiveWatch {
  config: WatchConfig;
  state: "scanning" | "watching" | "error" | "stopped";
  lastScanAt: string | null;
  error?: string;
  fsWatcher: FSWatcher | null;
  files: Map<string, WatchFileInfo>; // filePath → info
  queue: Promise<void>; // serialization chain
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const MAX_CONCURRENCY = 4;
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB

export function createFileWatchManager(opts: {
  sdk: StarkeepSdk;
  db: DatabaseSync;
  databaseAdapter: DatabaseAdapter;
  ownerId: string;
  appId: string;
}): FileWatchManager {
  const { sdk, db, databaseAdapter, ownerId, appId } = opts;
  const watches = new Map<string, ActiveWatch>();

  // Create the private watch_files table if it doesn't exist.
  // This table is owned entirely by the data-server and is never part of
  // the user data layer — no SDK, no records table, no sync engine.
  db.exec(`
    CREATE TABLE IF NOT EXISTS watch_files (
      file_path TEXT PRIMARY KEY,
      watch_id TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      data_record_id TEXT NOT NULL,
      mtime REAL NOT NULL,
      size_bytes INTEGER NOT NULL
    )
  `);

  // -- Helpers --

  async function findExistingByHash(contentHash: string): Promise<string | null> {
    const result = await databaseAdapter.query({
      kind: "data",
      filters: [
        { field: "content_hash" as any, operator: "eq" as any, value: contentHash },
      ],
      limit: 1,
    });
    const record = result.records.find((r) => !r.deletedAt);
    return record ? record.id : null;
  }

  function loadTrackingRecords(watchId: string): Map<string, WatchFileInfo> {
    const rows = db.prepare(
      "SELECT file_path, relative_path, content_hash, data_record_id, mtime FROM watch_files WHERE watch_id = ?",
    ).all(watchId) as {
      file_path: string;
      relative_path: string;
      content_hash: string;
      data_record_id: string;
      mtime: number;
    }[];

    const map = new Map<string, WatchFileInfo>();
    for (const r of rows) {
      map.set(r.file_path, {
        filePath: r.file_path,
        relativePath: r.relative_path,
        contentHash: r.content_hash,
        dataRecordId: r.data_record_id,
        mtime: r.mtime,
        status: "synced",
      });
    }
    return map;
  }

  function upsertTrackingRecord(
    watchId: string,
    filePath: string,
    relativePath: string,
    contentHash: string,
    dataRecordId: string,
    mtime: number,
    sizeBytes: number,
  ): void {
    db.prepare(`
      INSERT INTO watch_files (file_path, watch_id, relative_path, content_hash, data_record_id, mtime, size_bytes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(file_path) DO UPDATE SET
        watch_id = excluded.watch_id,
        relative_path = excluded.relative_path,
        content_hash = excluded.content_hash,
        data_record_id = excluded.data_record_id,
        mtime = excluded.mtime,
        size_bytes = excluded.size_bytes
    `).run(watchId, filePath, relativePath, contentHash, dataRecordId, mtime, sizeBytes);
  }

  function deleteTrackingRecord(filePath: string): void {
    db.prepare("DELETE FROM watch_files WHERE file_path = ?").run(filePath);
  }

  function deleteTrackingRecords(watchId: string): void {
    db.prepare("DELETE FROM watch_files WHERE watch_id = ?").run(watchId);
  }

  async function ingestFile(active: ActiveWatch, filePath: string): Promise<void> {
    const relativePath = relative(active.config.directoryPath, filePath);
    const filename = basename(filePath);

    if (isExcluded(filename, active.config.excludePatterns)) return;
    if (!matchesPatterns(filename, active.config.includePatterns)) return;

    try {
      let fileStat;
      try {
        fileStat = await stat(filePath);
      } catch (err: any) {
        if (err.code === "ENOENT") {
          const tracked = active.files.get(filePath);
          if (tracked?.dataRecordId) {
            await sdk.data.delete(tracked.dataRecordId as any);
          }
          deleteTrackingRecord(filePath);
          active.files.delete(filePath);
          return;
        }
        throw err;
      }
      if (!fileStat.isFile()) return;
      if (fileStat.size > MAX_FILE_SIZE) {
        console.warn(`Skipping large file (${(fileStat.size / 1024 / 1024).toFixed(0)}MB): ${filePath}`);
        return;
      }
      if (fileStat.size === 0) return;

      // Check if already tracked
      const existing = active.files.get(filePath);
      if (existing?.status === "synced" && existing.mtime === fileStat.mtimeMs) return;

      // Mark pending immediately so duplicate FS events skip this file while it's in-flight
      active.files.set(filePath, { filePath, relativePath, contentHash: "", dataRecordId: "", mtime: 0, status: "pending" });

      // Hash the file (streaming, no full buffer)
      const contentHash = await hashFile(filePath);

      // Check if we already have a tracking record with this hash
      if (existing && existing.contentHash === contentHash) {
        return; // No change
      }

      // Dedup: check if another record already has this content
      let dataRecordId = await findExistingByHash(contentHash);

      if (!dataRecordId) {
        const type = extensionOf(filePath);
        const contentType = mimeFromExtension(type);
        const title = basename(filePath, extname(filePath));

        const record = await sdk.data.putWithLocalFile(
          {
            type,
            ownerId,
            originAppId: appId,
            content: { title, fileName: filename, sourcePath: relativePath },
          },
          filePath,
          contentType,
        );
        dataRecordId = record.id;
      }

      // Persist tracking state in the private watch_files table
      upsertTrackingRecord(
        active.config.id,
        filePath,
        relativePath,
        contentHash,
        dataRecordId,
        fileStat.mtimeMs,
        fileStat.size,
      );

      active.files.set(filePath, {
        filePath,
        relativePath,
        contentHash,
        dataRecordId,
        mtime: fileStat.mtimeMs,
        status: "synced",
      });
    } catch (err) {
      console.error(`Failed to ingest ${filePath}:`, (err as Error).message);
      active.files.set(filePath, {
        filePath,
        relativePath,
        contentHash: "",
        dataRecordId: "",
        mtime: 0,
        status: "error",
      });
    }
  }

  async function scanDirectory(active: ActiveWatch): Promise<string[]> {
    const files: string[] = [];
    try {
      const entries = await readdir(active.config.directoryPath, {
        recursive: active.config.recursive,
        withFileTypes: true,
      });
      for (const entry of entries) {
        if (entry.isFile()) {
          const filePath = join(entry.parentPath ?? entry.path, entry.name);
          if (!isExcluded(entry.name, active.config.excludePatterns)) {
            if (matchesPatterns(entry.name, active.config.includePatterns)) {
              files.push(filePath);
            }
          }
        }
      }
    } catch (err) {
      console.error(`Scan failed for ${active.config.directoryPath}:`, (err as Error).message);
      active.state = "error";
      active.error = (err as Error).message;
    }
    return files;
  }

  async function processInBatches(active: ActiveWatch, files: string[]): Promise<void> {
    for (let i = 0; i < files.length; i += MAX_CONCURRENCY) {
      const batch = files.slice(i, i + MAX_CONCURRENCY);
      await Promise.allSettled(batch.map((f) => ingestFile(active, f)));
    }
  }

  function startFsWatcher(active: ActiveWatch): void {
    try {
      active.fsWatcher = watch(
        active.config.directoryPath,
        { recursive: active.config.recursive },
        (eventType, filename) => {
          if (!filename) return;
          const filePath = join(active.config.directoryPath, filename);
          // Debounce: queue the ingestion
          active.queue = active.queue.then(() => ingestFile(active, filePath)).catch(() => {});
        },
      );
    } catch (err) {
      console.error(`FS watcher failed for ${active.config.directoryPath}:`, (err as Error).message);
    }
  }

  // -- Public API --

  return {
    async startWatch(config) {
      if (watches.has(config.id)) return;

      const active: ActiveWatch = {
        config,
        state: "scanning",
        lastScanAt: null,
        fsWatcher: null,
        files: new Map(),
        queue: Promise.resolve(),
      };
      watches.set(config.id, active);

      // Load existing tracking records for delta scan
      active.files = loadTrackingRecords(config.id);

      // Scan and ingest new/changed files
      console.log(`Watch started: ${config.directoryPath}`);
      const files = await scanDirectory(active);
      await processInBatches(active, files);

      active.lastScanAt = new Date().toISOString();
      if (active.state !== "error") {
        active.state = "watching";
      }

      // Start FS event monitoring
      startFsWatcher(active);
      const synced = Array.from(active.files.values()).filter(f => f.status === "synced").length;
      console.log(`Watch ready: ${config.directoryPath} (${synced}/${active.files.size} files)`);
    },

    async stopWatch(watchId) {
      const active = watches.get(watchId);
      if (!active) return;
      active.fsWatcher?.close();
      active.state = "stopped";
      watches.delete(watchId);
      deleteTrackingRecords(watchId);
    },

    getStatus(watchId) {
      const active = watches.get(watchId);
      if (!active) return null;
      const files = Array.from(active.files.values());
      return {
        id: active.config.id,
        directoryPath: active.config.directoryPath,
        state: active.state,
        totalFiles: files.length,
        syncedFiles: files.filter(f => f.status === "synced").length,
        lastScanAt: active.lastScanAt,
        error: active.error,
      };
    },

    getAllStatuses() {
      return Array.from(watches.values()).map((a) => {
        const files = Array.from(a.files.values());
        return {
          id: a.config.id,
          directoryPath: a.config.directoryPath,
          state: a.state,
          totalFiles: files.length,
          syncedFiles: files.filter(f => f.status === "synced").length,
          lastScanAt: a.lastScanAt,
          error: a.error,
        };
      });
    },

    getWatchFiles(watchId) {
      const active = watches.get(watchId);
      if (!active) return [];
      return Array.from(active.files.values());
    },

    getFileStatus(filePath) {
      for (const [, active] of watches) {
        if (filePath.startsWith(active.config.directoryPath + "/")) {
          const info = active.files.get(filePath);
          return {
            watched: true,
            synced: info?.status === "synced",
            watchId: active.config.id,
            recordId: info?.dataRecordId,
          };
        }
      }
      return { watched: false, synced: false };
    },

    getDirectoryStatus(dirPath) {
      for (const [, active] of watches) {
        if (dirPath === active.config.directoryPath || dirPath.startsWith(active.config.directoryPath + "/")) {
          return {
            watched: true,
            watchId: active.config.id,
            directoryPath: active.config.directoryPath,
          };
        }
      }
      return { watched: false };
    },

    async shutdown() {
      for (const [, active] of watches) {
        active.fsWatcher?.close();
      }
      watches.clear();
    },
  };
}
