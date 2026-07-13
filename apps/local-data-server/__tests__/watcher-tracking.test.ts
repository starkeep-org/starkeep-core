/**
 * In-process unit tests for FileWatchManager's private `watch_files` tracking
 * table and its restart/delta-scan behavior. These drive `createFileWatchManager`
 * directly (real in-memory SQLite, faked SDK + database adapter) so a single
 * ingest can be triggered deterministically — the live `fs.watch` path coalesces
 * events unpredictably and can't reliably exercise these code paths.
 *
 * Regression coverage for two bugs:
 *  1. `upsertTrackingRecord` bound `file_path`/`watch_id` in swapped order, so
 *     every file collided on the `file_path` PRIMARY KEY (one surviving row per
 *     watch) and `loadTrackingRecords` (WHERE watch_id = ?) never matched.
 *  2. The "content unchanged" fast-path returned while the file was still marked
 *     `pending`, permanently dropping syncedFiles below totalFiles (the admin
 *     surface's stuck "7/8").
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, utimes, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileWatchManager, type FileWatchManager } from "../watcher.js";

// A minimal fake data plane: putWithLocalFile hashes the file (mirroring the
// real SDK's content addressing) so findExistingByHash dedup behaves faithfully.
function makeDeps() {
  let seq = 0;
  const records: { id: string; content_hash: string; deletedAt: string | null }[] = [];
  const databaseAdapter = {
    async query(q: { filters?: { field: string; value: unknown }[]; limit?: number }) {
      const hashFilter = q.filters?.find((f) => f.field === "content_hash");
      const matches = hashFilter
        ? records.filter((r) => r.content_hash === hashFilter.value)
        : records.slice();
      return { records: matches.slice(0, q.limit ?? matches.length) };
    },
  };
  const sdk = {
    data: {
      async putWithLocalFile(_meta: unknown, filePath: string) {
        const content_hash = createHash("sha256").update(await readFile(filePath)).digest("hex");
        const id = `rec-${++seq}`;
        records.push({ id, content_hash, deletedAt: null });
        return { id };
      },
      async delete() {},
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { sdk: sdk as any, databaseAdapter: databaseAdapter as any, records };
}

function status(mgr: FileWatchManager, watchId: string) {
  const s = mgr.getStatus(watchId)!;
  return { synced: s.syncedFiles, total: s.totalFiles };
}

describe("watch_files tracking table", () => {
  it("keys each file's tracking row by its own path (not the watch id)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wtrack-"));
    await writeFile(join(dir, "one.txt"), "content-one");
    await writeFile(join(dir, "two.txt"), "content-two");
    const db = new DatabaseSync(":memory:");
    const { sdk, databaseAdapter } = makeDeps();
    const mgr = createFileWatchManager({ sdk, db, databaseAdapter, appId: "app" });

    await mgr.startWatch({ id: "w1", directoryPath: dir, recursive: false });

    // Two distinct files must produce two distinct, correctly-keyed rows. With
    // the columns swapped both rows would collide on file_path === "w1", leaving
    // a single row.
    const rows = db
      .prepare("SELECT file_path, watch_id FROM watch_files ORDER BY file_path")
      .all() as { file_path: string; watch_id: string }[];
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.file_path)).toEqual([join(dir, "one.txt"), join(dir, "two.txt")]);
    expect(rows.every((r) => r.watch_id === "w1")).toBe(true);

    await mgr.shutdown();
    await rm(dir, { recursive: true, force: true });
  });

  it("reloads tracking after a restart so unchanged files are not re-ingested", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wtrack-"));
    await writeFile(join(dir, "a.txt"), "aaa");
    await writeFile(join(dir, "b.txt"), "bbb");
    const db = new DatabaseSync(":memory:");
    const { sdk, databaseAdapter, records } = makeDeps();

    const mgr1 = createFileWatchManager({ sdk, db, databaseAdapter, appId: "app" });
    await mgr1.startWatch({ id: "w1", directoryPath: dir, recursive: false });
    expect(records).toHaveLength(2);
    await mgr1.shutdown();

    // Restart against the same persisted db: nothing changed on disk, so the
    // delta scan should recognize both files as already-synced and create no
    // new records. A broken tracking table (rows unmatchable by watch_id) would
    // force a full re-ingest.
    const mgr2 = createFileWatchManager({ sdk, db, databaseAdapter, appId: "app" });
    await mgr2.startWatch({ id: "w1", directoryPath: dir, recursive: false });
    expect(status(mgr2, "w1")).toEqual({ synced: 2, total: 2 });
    expect(records).toHaveLength(2); // no duplicate ingests

    await mgr2.shutdown();
    await rm(dir, { recursive: true, force: true });
  });

  it("does not strand a file as pending when its mtime moved but bytes did not", async () => {
    // The reported "7/8" symptom: after a restart, a file whose mtime advanced
    // while the server was down but whose content is identical must settle back
    // to synced. The buggy fast-path left it stuck at "pending" forever, so
    // syncedFiles stayed below totalFiles.
    const dir = await mkdtemp(join(tmpdir(), "wtrack-"));
    await writeFile(join(dir, "target.txt"), "unchanged-bytes");
    const db = new DatabaseSync(":memory:");
    const { sdk, databaseAdapter, records } = makeDeps();

    const mgr1 = createFileWatchManager({ sdk, db, databaseAdapter, appId: "app" });
    await mgr1.startWatch({ id: "w1", directoryPath: dir, recursive: false });
    expect(status(mgr1, "w1")).toEqual({ synced: 1, total: 1 });
    await mgr1.shutdown();

    // Bump only the mtime; the bytes are identical.
    const future = new Date(Date.now() + 30_000);
    await utimes(join(dir, "target.txt"), future, future);

    const mgr2 = createFileWatchManager({ sdk, db, databaseAdapter, appId: "app" });
    await mgr2.startWatch({ id: "w1", directoryPath: dir, recursive: false });

    expect(status(mgr2, "w1")).toEqual({ synced: 1, total: 1 });
    expect(records).toHaveLength(1); // unchanged content: no new record

    await mgr2.shutdown();
    await rm(dir, { recursive: true, force: true });
  });
});
