/**
 * FileWatchManager — monitors local directories and syncs files to Starkeep.
 *
 * Each watched directory gets:
 * - A real data record per file (e.g., media:photo) with the file stored in object storage
 *
 * File tracking state (path ↔ record ID mapping) is stored in a private `watch_files`
 * SQLite table managed here — it never touches the user data layer.
 *
 * ## A watched folder is a view of the library, not a vote over it
 *
 * Two directions of change meet here, and they do not mean the same thing.
 *
 * A file appearing on disk is a request to put it in the library. A file
 * *leaving* the disk is not a request to delete it from the library: the folder
 * is one node's view, and a tombstone would travel to the cloud and to every
 * other node, so a backup machine would delete the only remaining copy of its
 * own backup. So a removal **evicts** — the record stays live, this node's copy
 * of the bytes goes, and residency reads `evicted`, which is exactly what "Free
 * up space" produces for one file. The eviction runs only behind the same
 * durability proof "Free up space" demands; without it nothing is removed and
 * the path is reported as possibly lost.
 *
 * In the other direction, a record the person deleted must not come back. A
 * record id is a pure function of parent, filename and content hash, so
 * re-ingesting the same file writes the *tombstoned row's own id* and `put`
 * upserts every column: one call is the whole resurrection, with no second
 * write to catch. The guard therefore runs before any write, and the verdict is
 * remembered against the path as `deleted-from-library` so the next scan does
 * not ask again.
 */

import type { RawDatabase } from "@starkeep/storage-adapter";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { join, relative, extname, basename } from "node:path";
import { pipeline } from "node:stream/promises";
import type { StarkeepSdk } from "../../packages/sdk/src/types.js";
import type { DatabaseAdapter } from "../../packages/storage-adapter/src/database/adapter.js";
import type { ObjectStorageAdapter } from "../../packages/storage-adapter/src/object-storage/adapter.js";
import { createStarkeepId, defaultTypeForExtension, type StandInStandards } from "@starkeep/protocol-primitives";
import { sqliteCompiler as qb } from "@starkeep/storage-sqlite";
import {
  blobCandidateForRecord,
  proveCloudCopies,
  type ReplicaProbe,
  type ResidencyManager,
} from "@starkeep/sync-engine";

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

/**
 * Where a watched path stands with respect to the library.
 *
 * Four readings, because a watched folder promises that everything inside it is
 * in the library and three different things break that promise in three
 * different ways:
 *
 * - `synced` — the file is on disk and the library holds it. The ordinary state.
 * - `evicted` — the file left this disk and the cloud holds its bytes, proved.
 *   The record is live; a read fetches the bytes back on demand. Nothing is
 *   lost and nothing needs the person's attention.
 * - `possibly-lost` — the file left this disk and no complete cloud copy was
 *   confirmed, so the bytes may be gone for good. The only new way a person can
 *   lose data, and the one state that deserves a report.
 * - `deleted-from-library` — the file is on disk and the library ignores it on
 *   purpose, because the person deleted the record. Re-ingesting would resurrect
 *   the tombstone, so the watcher declines and offers the way back instead.
 *
 * The plan's three names collapsed `evicted` and `possibly-lost` into one
 * "missing-on-disk". They are kept apart here because the watch status has to
 * tell the person which of the two happened, and `evicted` is the word
 * residency already uses for the same fact.
 */
export type WatchLibraryState = "synced" | "evicted" | "possibly-lost" | "deleted-from-library";

export interface WatchStatus {
  id: string;
  directoryPath: string;
  state: "scanning" | "watching" | "error" | "stopped";
  totalFiles: number;
  syncedFiles: number;
  lastScanAt: string | null;
  error?: string;
  /**
   * The two states that break a watched folder's promise, plus the benign one,
   * named as paths rather than counted. A count tells the person something is
   * wrong and a path tells them which file, and only one of those is actionable.
   */
  possiblyLost: string[];
  excluded: string[];
  evicted: string[];
}

export interface WatchFileInfo {
  filePath: string;
  relativePath: string;
  contentHash: string;
  dataRecordId: string;
  mtime: number;
  status: "synced" | "pending" | "error";
  libraryState: WatchLibraryState;
}

/** What `addBack` did, or why it could not. */
export type AddBackOutcome =
  | { readonly ok: true; readonly recordId: string }
  | { readonly ok: false; readonly status: number; readonly error: string };

export interface FileWatchManager {
  startWatch(config: WatchConfig): Promise<void>;
  stopWatch(watchId: string): Promise<void>;
  getStatus(watchId: string): WatchStatus | null;
  getAllStatuses(): WatchStatus[];
  getWatchFiles(watchId: string): WatchFileInfo[];
  getFileStatus(filePath: string): { watched: boolean; synced: boolean; watchId?: string; recordId?: string };
  getDirectoryStatus(dirPath: string): { watched: boolean; watchId?: string; directoryPath?: string };
  /**
   * Put an excluded path back in the library.
   *
   * Restores the tombstoned record rather than writing a fresh one. Because the
   * id is content-addressed, re-ingesting the file would land on the tombstone's
   * own id — but through `put`, which would revive the row with `version` reset
   * to 1 and its labels and metadata still retracted. The restore planner lifts
   * all three, so the item returns as itself.
   */
  addBack(filePath: string): Promise<AddBackOutcome>;
  /**
   * Re-read the library's verdict on these records, for the paths this watcher
   * tracks.
   *
   * The guard inside the ingest path runs on a filesystem event or a scan, and a
   * record deleted somewhere else changes nothing on this disk — so without this
   * call the watcher would not learn until the next event or restart, and a path
   * excluded by a deletion another node later undid would stay excluded for ever.
   * Both directions are handled here.
   */
  recheckRecords(recordIds: readonly string[]): Promise<void>;
  shutdown(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Identification
// ---------------------------------------------------------------------------

// The filename extension (lowercase, no dot); "" for extension-less files.
// Advisory only — fed to `defaultTypeForExtension` to pick a default Starkeep
// type. Unmapped/empty extensions become the Drive-only `other/other` type.
// The watcher never skips: every file is ingested.
function extensionOf(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return ext.startsWith(".") ? ext.slice(1) : ext;
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
/** Record ids per reverse-lookup query, so one sync round cannot build an unbounded statement. */
const RECHECK_CHUNK = 200;

export interface FileWatchManagerOptions {
  sdk: StarkeepSdk;
  db: RawDatabase;
  databaseAdapter: DatabaseAdapter;
  objectStorageAdapter: ObjectStorageAdapter;
  appId: string;
  /**
   * This node's residency, for the one thing a removal from disk has to do:
   * record the departure, so the record reads `evicted` and no acquisition pass
   * brings the bytes back on its own.
   */
  residency: ResidencyManager;
  /**
   * Where the cloud copy is proved, read per removal rather than held: the
   * supervisor's probe comes and goes with the cloud connection, and a removal
   * with no probe must prove nothing rather than prove it vacuously.
   */
  probes: () => readonly ReplicaProbe[];
  /** The library's current stand-in standards, which the proof reads. */
  standards: () => StandInStandards;
}

export function createFileWatchManager(opts: FileWatchManagerOptions): FileWatchManager {
  const { sdk, db, databaseAdapter, objectStorageAdapter, appId, residency } = opts;
  const watches = new Map<string, ActiveWatch>();

  // Create the private watch_files table if it doesn't exist.
  // This table is owned entirely by the data-server and is never part of
  // the user data layer — no SDK, no records table, no sync engine.
  db.exec(
    qb.schema
      .createTable("watch_files")
      .ifNotExists()
      .addColumn("file_path", "text", (c) => c.primaryKey())
      .addColumn("watch_id", "text", (c) => c.notNull())
      .addColumn("relative_path", "text", (c) => c.notNull())
      .addColumn("content_hash", "text", (c) => c.notNull())
      .addColumn("data_record_id", "text", (c) => c.notNull())
      .addColumn("mtime", "real", (c) => c.notNull())
      .addColumn("size_bytes", "integer", (c) => c.notNull())
      // Where the path stands with the library. A `deleted-from-library` mark is
      // the only thing in this table that cannot be re-derived from the disk, so
      // it is the reason the table is loaded on startup rather than rebuilt.
      .addColumn("library_state", "text", (c) => c.notNull().defaultTo("synced"))
      .compile().sql,
  );
  // The reverse lookup `recheckRecords` makes: a sync round names record ids and
  // this table is keyed by path.
  db.exec(
    qb.schema
      .createIndex("watch_files_data_record_id")
      .ifNotExists()
      .on("watch_files")
      .column("data_record_id")
      .compile().sql,
  );

  // -- Helpers --

  /**
   * A live record already holding this content, for dedup.
   *
   * `deletedAt isNull` belongs in the query rather than in a filter over the
   * page: with `limit: 1` and the check applied afterwards, a tombstoned row
   * occupying the single slot hid a live record with the same content hash, and
   * which row that was depended on what the database happened to return.
   */
  async function findExistingByHash(contentHash: string): Promise<string | null> {
    const result = await databaseAdapter.query({
      filters: [
        { field: "content_hash", operator: "eq", value: contentHash },
        { field: "deletedAt", operator: "isNull" },
      ],
      limit: 1,
    });
    return result.records[0]?.id ?? null;
  }

  /**
   * Restore the watched file as this record's local object when its database
   * row survived but the local object store did not.
   *
   * Also the repair path for a file that was evicted and has come back: the
   * arrival is noted so the resident set stops reading these bytes as departed,
   * which is what `wasEvicted` would otherwise keep answering about a key whose
   * bytes are here again.
   */
  async function ensureLocalObject(recordId: string, filePath: string): Promise<boolean> {
    const record = await sdk.data.get(createStarkeepId(recordId));
    if (!record?.objectStorageKey) return false;
    if (await objectStorageAdapter.has(record.objectStorageKey)) return true;

    const options = { contentType: record.mimeType ?? undefined };
    if (objectStorageAdapter.putSymlink) {
      await objectStorageAdapter.putSymlink(record.objectStorageKey, filePath, options);
    } else {
      await objectStorageAdapter.put(record.objectStorageKey, await readFile(filePath), options);
    }
    const candidate = blobCandidateForRecord(record);
    if (candidate) await residency.noteArrival(candidate);
    console.log(`Restored watched object: ${filePath}`);
    return true;
  }

  function loadTrackingRecords(watchId: string): Map<string, WatchFileInfo> {
    const query = qb
      .selectFrom("watch_files")
      .select([
        "file_path",
        "relative_path",
        "content_hash",
        "data_record_id",
        "mtime",
        "library_state",
      ])
      .where("watch_id", "=", watchId)
      .compile();
    const rows = db.prepare(query.sql).all(...(query.parameters as string[])) as {
      file_path: string;
      relative_path: string;
      content_hash: string;
      data_record_id: string;
      mtime: number;
      library_state: string;
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
        libraryState: r.library_state as WatchLibraryState,
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
    libraryState: WatchLibraryState,
  ): void {
    const query = qb
      .insertInto("watch_files")
      .values({
        file_path: filePath,
        watch_id: watchId,
        relative_path: relativePath,
        content_hash: contentHash,
        data_record_id: dataRecordId,
        mtime,
        size_bytes: sizeBytes,
        library_state: libraryState,
      })
      .onConflict((oc) =>
        oc.column("file_path").doUpdateSet((eb) => ({
          watch_id: eb.ref("excluded.watch_id"),
          relative_path: eb.ref("excluded.relative_path"),
          content_hash: eb.ref("excluded.content_hash"),
          data_record_id: eb.ref("excluded.data_record_id"),
          mtime: eb.ref("excluded.mtime"),
          size_bytes: eb.ref("excluded.size_bytes"),
          library_state: eb.ref("excluded.library_state"),
        })),
      )
      .compile();
    db.prepare(query.sql).run(...(query.parameters as (string | number)[]));
  }

  /**
   * The watched paths holding these records, read from the table rather than
   * from the in-memory maps: the table is indexed by record id and a scan of
   * every tracked file would cost the whole library per sync round.
   */
  function trackedPathsForRecords(recordIds: readonly string[]): string[] {
    const query = qb
      .selectFrom("watch_files")
      .select(["file_path"])
      .where("data_record_id", "in", [...recordIds])
      .compile();
    const rows = db.prepare(query.sql).all(...(query.parameters as string[])) as {
      file_path: string;
    }[];
    return rows.map((r) => r.file_path);
  }

  /**
   * Another watched path that still supplies the departed path's bytes: same
   * content hash, tracked as on disk, and still there with the mtime it was
   * ingested at. Identical files share one content-addressed key — under one
   * record when they arrive one after the other, under two when one scan ingests
   * them in parallel — so one of them leaving the disk says nothing about the
   * bytes while the other remains.
   *
   * The mtime is the cheap evidence the ingest path already trusts; a path whose
   * file moved is left to its own event rather than hashed here.
   */
  async function survivingPathFor(
    departed: string,
  ): Promise<{ filePath: string; recordId: string } | null> {
    const query = qb
      .selectFrom("watch_files")
      .select(["file_path", "data_record_id", "mtime"])
      .where(
        "content_hash",
        "=",
        qb.selectFrom("watch_files").select("content_hash").where("file_path", "=", departed),
      )
      .where("file_path", "!=", departed)
      .where("library_state", "=", "synced")
      .compile();
    const rows = db.prepare(query.sql).all(...(query.parameters as string[])) as {
      file_path: string;
      data_record_id: string;
      mtime: number;
    }[];
    for (const row of rows) {
      const onDisk = await stat(row.file_path).catch(() => null);
      if (onDisk?.isFile() && onDisk.mtimeMs === row.mtime) {
        return { filePath: row.file_path, recordId: row.data_record_id };
      }
    }
    return null;
  }

  /** Move one path to a new library state, leaving everything else about it alone. */
  function setLibraryState(filePath: string, libraryState: WatchLibraryState): void {
    const query = qb
      .updateTable("watch_files")
      .set({ library_state: libraryState })
      .where("file_path", "=", filePath)
      .compile();
    db.prepare(query.sql).run(...(query.parameters as (string | number)[]));
  }

  function deleteTrackingRecord(filePath: string): void {
    const query = qb.deleteFrom("watch_files").where("file_path", "=", filePath).compile();
    db.prepare(query.sql).run(...(query.parameters as string[]));
  }

  function deleteTrackingRecords(watchId: string): void {
    const query = qb.deleteFrom("watch_files").where("watch_id", "=", watchId).compile();
    db.prepare(query.sql).run(...(query.parameters as string[]));
  }

  /**
   * The file left this disk. Let this node's copy of the bytes go, and leave the
   * record alone.
   *
   * A tombstone here would travel: the cloud and every other node would apply
   * it, so a backup machine whose folder was cleaned would delete the library's
   * only remaining copy. An eviction is local by construction — the record stays
   * live, residency reads `evicted`, and a read brings the bytes back through the
   * Drive channel.
   *
   * The proof is the same one "Free up space" demands: complete, checksum-verified
   * cloud copies of the file, of its original and of the original's canonical
   * stand-in. Without it nothing is removed, because unlinking a symlink whose
   * target is already gone would destroy the last reference to the content. That
   * case is genuine data loss and is reported rather than stated as a state.
   *
   * Nothing is removed either while another watched path supplies the same bytes,
   * which is the case content addressing creates for two identical files.
   *
   * Returns the state to record against the path.
   */
  async function evictFromDisk(
    filePath: string,
    recordId: string,
  ): Promise<"evicted" | "possibly-lost"> {
    const record = await databaseAdapter.get(createStarkeepId(recordId));
    // No record, or one already deleted: there is nothing here to protect and
    // nothing to prove. The key, if any, is the tombstone's and the reaper's.
    if (!record || record.deletedAt) return "evicted";
    if (!record.objectStorageKey) return "evicted";

    // Another path still holds the same bytes, so nothing leaves this node. The
    // link may name the departed path, so it is pointed at the survivor rather
    // than left to dangle until the survivor's next event.
    const survivor = await survivingPathFor(filePath);
    if (survivor && (await ensureLocalObject(survivor.recordId, survivor.filePath))) {
      console.log(
        `[watch] ${filePath} left the disk; ${survivor.filePath} holds the same bytes, so they stay here`,
      );
      return "evicted";
    }

    const proof = await proveCloudCopies(
      { databaseAdapter, standards: opts.standards() },
      record,
      opts.probes(),
    );
    if (!proof.ok) {
      console.warn(
        `[watch] ${filePath} left the disk and no cloud copy is confirmed (${proof.detail}); ` +
          `the record stays staged and the path is reported as possibly lost`,
      );
      return "possibly-lost";
    }

    // The symlink, not its target: `delete` unlinks the entry inside the object
    // store, and the watched file is already gone anyway. Removing the dangling
    // link rather than leaving it is what lets a later on-demand fetch write a
    // regular file, and it keeps `resolvePath` from naming a path that is not there.
    await objectStorageAdapter.delete(record.objectStorageKey);
    // The candidate, not the key: the watcher's bytes arrived by a symlink that
    // never passed through a sync round, so the resident-set row has to be written
    // before the departure can be recorded against it.
    const candidate = blobCandidateForRecord(record);
    if (candidate) await residency.noteDeparture(candidate);
    console.log(`[watch] ${filePath} left the disk; its bytes stay in the cloud (evicted)`);
    return "evicted";
  }

  /**
   * Whether the library has deliberately deleted the record this path holds.
   *
   * Read through the adapter rather than the SDK, because `sdk.data.get` answers
   * null for a tombstone and "no such record" and "deliberately deleted" are the
   * two answers that have to be told apart here.
   */
  async function wasDeletedFromLibrary(recordId: string): Promise<boolean> {
    if (!recordId) return false;
    const record = await databaseAdapter.get(createStarkeepId(recordId));
    return record !== null && record.deletedAt !== null;
  }

  /** Mark the path excluded, in memory and in the tracking table. */
  function markExcluded(active: ActiveWatch, existing: WatchFileInfo): void {
    active.files.set(existing.filePath, {
      ...existing,
      status: "synced",
      libraryState: "deleted-from-library",
    });
    setLibraryState(existing.filePath, "deleted-from-library");
    console.log(
      `[watch] ${existing.filePath} is on disk and its record was deleted; ` +
        `leaving it out of the library`,
    );
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
      } catch (err) {
        if ((err as { code?: string }).code === "ENOENT") {
          const tracked = active.files.get(filePath);
          if (!tracked) return;
          // The row stays, marked absent from disk: it is what keeps the startup
          // scan from re-ingesting the file if it comes back, and what lets the
          // watch status say which of the two things happened.
          const state = tracked.dataRecordId
            ? await evictFromDisk(filePath, tracked.dataRecordId)
            : "evicted";
          active.files.set(filePath, { ...tracked, status: "synced", libraryState: state });
          setLibraryState(filePath, state);
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

      // The resurrection guard, before anything that could write. A record id is
      // a pure function of parent, filename and content hash, so re-ingesting
      // this file would write the tombstoned row's *own* id — and `put` upserts
      // every column, resetting `version` to 1 and overwriting `deleted_at`. One
      // call is the whole resurrection, so there is no later write to correct.
      //
      // Asked only of a path the library already knows, and skipped once the
      // verdict is recorded: new bytes at an excluded path are a new file and
      // mint a new id, which is why the mark is cleared when the hash moves.
      if (existing?.dataRecordId) {
        if (existing.libraryState === "deleted-from-library") {
          // An untouched file cannot have new bytes, so the mtime answers first
          // and the hash is only paid for when the file actually moved.
          if (existing.mtime === fileStat.mtimeMs) return;
          if (existing.contentHash === (await hashFile(filePath))) return;
          // Different bytes, so a different record. Fall through and ingest.
        } else if (await wasDeletedFromLibrary(existing.dataRecordId)) {
          markExcluded(active, existing);
          return;
        }
      }

      if (
        existing?.status === "synced" &&
        existing.libraryState === "synced" &&
        existing.mtime === fileStat.mtimeMs &&
        (await ensureLocalObject(existing.dataRecordId, filePath))
      ) {
        return;
      }

      // Mark pending immediately so duplicate FS events skip this file while it's in-flight
      active.files.set(filePath, {
        filePath,
        relativePath,
        contentHash: "",
        dataRecordId: "",
        mtime: 0,
        status: "pending",
        libraryState: "synced",
      });

      // Hash the file (streaming, no full buffer)
      const contentHash = await hashFile(filePath);

      // Check if we already have a tracking record with this hash. The content
      // is unchanged (only the mtime moved — e.g. a re-save or a coalesced FS
      // event), so there's nothing to re-ingest. Restore the synced entry with
      // the new mtime; returning here without doing so would strand the file in
      // the "pending" placeholder set above, permanently dropping syncedFiles
      // below totalFiles (the "7/8, never synced" symptom).
      if (existing && existing.contentHash === contentHash) {
        const restored = await ensureLocalObject(existing.dataRecordId, filePath);
        if (!restored) {
          deleteTrackingRecord(filePath);
          active.files.delete(filePath);
        } else {
          active.files.set(filePath, {
            ...existing,
            mtime: fileStat.mtimeMs,
            status: "synced",
            libraryState: "synced",
          });
          upsertTrackingRecord(
            active.config.id,
            filePath,
            existing.relativePath,
            existing.contentHash,
            existing.dataRecordId,
            fileStat.mtimeMs,
            fileStat.size,
            "synced",
          );
          return;
        }
      }

      // Dedup: check if another record already has this content
      let dataRecordId = await findExistingByHash(contentHash);

      if (dataRecordId && !(await ensureLocalObject(dataRecordId, filePath))) {
        dataRecordId = null;
      }

      if (!dataRecordId) {
        // The watcher has only a filename, so it picks a default Starkeep type
        // from the extension via the advisory map. MIME is left null — there is
        // no over-the-network Content-Type on a local-disk ingest.
        const type = defaultTypeForExtension(extensionOf(filePath));

        const record = await sdk.data.putWithLocalFile(
          {
            type,
            originAppId: appId,
            originalFilename: filename,
          },
          filePath,
          null,
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
        "synced",
      );

      active.files.set(filePath, {
        filePath,
        relativePath,
        contentHash,
        dataRecordId,
        mtime: fileStat.mtimeMs,
        status: "synced",
        libraryState: "synced",
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
        libraryState: "synced",
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

  /**
   * One watch's status, including the paths in the three states a bare
   * synced-of-total count cannot express.
   */
  function statusOf(active: ActiveWatch): WatchStatus {
    const files = Array.from(active.files.values());
    const pathsIn = (state: WatchLibraryState): string[] =>
      files.filter((f) => f.libraryState === state).map((f) => f.filePath).sort();
    return {
      id: active.config.id,
      directoryPath: active.config.directoryPath,
      state: active.state,
      totalFiles: files.length,
      syncedFiles: files.filter((f) => f.status === "synced" && f.libraryState === "synced").length,
      lastScanAt: active.lastScanAt,
      error: active.error,
      possiblyLost: pathsIn("possibly-lost"),
      excluded: pathsIn("deleted-from-library"),
      evicted: pathsIn("evicted"),
    };
  }

  /** The watch a path belongs to, and what this watcher knows about it. */
  function findTracked(
    filePath: string,
  ): { active: ActiveWatch; tracked: WatchFileInfo } | null {
    for (const active of watches.values()) {
      const tracked = active.files.get(filePath);
      if (tracked) return { active, tracked };
    }
    return null;
  }

  /**
   * Re-read the library's verdict on these records. See the interface.
   *
   * Two directions, and the restore direction is the one that cannot wait for a
   * filesystem event: the ingest guard returns early for an excluded path whose
   * bytes have not changed, so a record another node restored would leave the
   * path excluded for ever. Identical bytes mean touching the file does not help
   * either, because the hash is what the guard compares.
   *
   * `evicted` and `possibly-lost` paths are left alone. Neither is a statement
   * about the library's opinion of the record, and the file is not on disk to
   * re-link or to exclude.
   *
   * The work runs on each watch's own queue, so it serializes behind an in-flight
   * ingest of the same path rather than racing it.
   */
  async function recheckRecords(recordIds: readonly string[]): Promise<void> {
    if (recordIds.length === 0) return;
    const byWatch = new Map<ActiveWatch, WatchFileInfo[]>();
    for (let i = 0; i < recordIds.length; i += RECHECK_CHUNK) {
      const chunk = recordIds.slice(i, i + RECHECK_CHUNK);
      const paths = trackedPathsForRecords(chunk);
      for (const filePath of paths) {
        const entry = findTracked(filePath);
        if (!entry) continue;
        const { active, tracked } = entry;
        if (tracked.libraryState !== "synced" && tracked.libraryState !== "deleted-from-library") {
          continue;
        }
        const list = byWatch.get(active);
        if (list) list.push(tracked);
        else byWatch.set(active, [tracked]);
      }
    }
    if (byWatch.size === 0) return;

    const queued: Promise<void>[] = [];
    for (const [active, tracked] of byWatch) {
      active.queue = active.queue.then(async () => {
        for (const file of tracked) {
          // Re-read rather than trust the snapshot: the queue may have run an
          // ingest of this very path while this call waited its turn.
          const current = active.files.get(file.filePath);
          if (!current) continue;
          const deleted = await wasDeletedFromLibrary(current.dataRecordId);
          if (deleted && current.libraryState === "synced") {
            markExcluded(active, current);
          } else if (!deleted && current.libraryState === "deleted-from-library") {
            // The mark first, or the ingest below declines to re-link the file.
            // The same two steps `addBack` runs once its own restore returns.
            active.files.set(current.filePath, { ...current, libraryState: "synced" });
            setLibraryState(current.filePath, "synced");
            console.log(
              `[watch] ${current.filePath} is in the library again; putting it back`,
            );
            await ingestFile(active, current.filePath);
          }
        }
      });
      // The chain is left resolved, exactly as the FS-event path leaves it: a
      // `then` on a rejected queue would silently drop every later recheck.
      active.queue = active.queue.catch((err: Error) =>
        console.warn(`[watch] rechecking the library's verdict failed: ${err.message}`),
      );
      queued.push(active.queue);
    }
    await Promise.allSettled(queued);
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

      // The opposite comparison, which the scan alone never made: it enumerates
      // the files that exist and says nothing about the rows for files that do
      // not. A file removed while this process was stopped was invisible until
      // now. The treatment is the same eviction an FS event gets, which is what
      // makes this safe to run unattended — nothing here can propagate a delete.
      if (active.state !== "error") {
        const onDisk = new Set(files);
        for (const tracked of [...active.files.values()]) {
          if (onDisk.has(tracked.filePath)) continue;
          if (tracked.libraryState !== "synced") continue;
          const state = tracked.dataRecordId
            ? await evictFromDisk(tracked.filePath, tracked.dataRecordId)
            : "evicted";
          active.files.set(tracked.filePath, { ...tracked, status: "synced", libraryState: state });
          setLibraryState(tracked.filePath, state);
        }
      }

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

    recheckRecords,

    getStatus(watchId) {
      const active = watches.get(watchId);
      return active ? statusOf(active) : null;
    },

    getAllStatuses() {
      return Array.from(watches.values()).map(statusOf);
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

    async addBack(filePath) {
      const entry = findTracked(filePath);
      if (!entry) {
        return { ok: false, status: 404, error: `"${filePath}" is not a watched path` };
      }
      const { active, tracked } = entry;
      if (tracked.libraryState !== "deleted-from-library") {
        return {
          ok: false,
          status: 409,
          error: `"${filePath}" is not excluded from the library`,
        };
      }
      try {
        // Restore rather than re-ingest. The id is content-addressed, so a fresh
        // `putWithLocalFile` would land on the tombstoned row's own id through
        // `put` — reviving the row with `version` reset to 1 and its labels and
        // metadata still retracted. The restore planner lifts all three, so the
        // item comes back as itself.
        //
        // Asked of the row first, because the record may already be live: another
        // node's restore reaches this one over sync, and `planRecordRestore`
        // refuses a live record with a 409. `recheckRecords` normally clears the
        // mark before anyone gets here, and this is what keeps the way back open
        // when no round announced it.
        const row = await databaseAdapter.get(createStarkeepId(tracked.dataRecordId));
        if (row === null || row.deletedAt !== null) {
          // A missing row still asks, so a caller naming a record this node does
          // not hold gets the restore path's own answer rather than a silent
          // re-ingest under a fresh id.
          await sdk.data.restore(createStarkeepId(tracked.dataRecordId));
        }
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode ?? 500;
        return { ok: false, status, error: (err as Error).message };
      }
      // Clear the mark first, so the ingest below is allowed to re-link the file.
      active.files.set(filePath, { ...tracked, libraryState: "synced" });
      setLibraryState(filePath, "synced");
      // The bytes: the record's object key may be gone — the reaper, or an
      // eviction on this node — and the file on disk is what supplies them again.
      await ingestFile(active, filePath);
      return { ok: true, recordId: tracked.dataRecordId };
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
