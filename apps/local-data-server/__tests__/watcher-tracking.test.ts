/**
 * The watcher, driven directly against a real SDK, a real SQLite database, a real
 * object store on disk, and a real residency manager.
 *
 * `createFileWatchManager` is called here rather than through the server because
 * the live `fs.watch` path coalesces events unpredictably. Every case below drives
 * the *startup* path instead — shut the manager down, change the directory, start a
 * fresh manager over the same database — which is deterministic, is itself one of
 * the paths under test (a removal while the watcher was stopped used to be
 * invisible), and reaches the same `ingestFile` the FS events reach. The live-event
 * path is covered end to end in `watcher.test.ts`.
 *
 * The fakes are gone on purpose. The previous version of this file stubbed
 * `sdk.data.delete()` to a no-op, which is exactly why the watcher's delete path —
 * a local `unlink` tombstoning the record for the whole library, and a deleted
 * record resurrected by the next scan — was never caught by a test. The only thing
 * still faked is the cloud, which is a {@link ReplicaProbe} over a second object
 * store, because that is all the cloud is to this code.
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, utimes, rm, unlink, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createHLCClock,
  DEFAULT_STAND_IN_STANDARDS,
  DEFAULT_SYNC_DOWN_CEILINGS,
  type HLCClock,
  type StarkeepId,
} from "@starkeep/protocol-primitives";
import { SqliteDatabaseAdapter } from "@starkeep/storage-sqlite";
// Not re-exported from the package index on purpose — it is Node-only.
import { nodeSqliteDriver } from "../../../packages/storage-sqlite/src/node-driver.js";
import { FsObjectStorageAdapter } from "@starkeep/storage-fs";
import { MockObjectStorageAdapter } from "@starkeep/storage-adapter";
import {
  blobCandidateForRecord,
  createResidencyManager,
  type ReplicaProbe,
  type ResidencyManager,
} from "@starkeep/sync-engine";
import { createStarkeepSdk, type StarkeepSdk } from "@starkeep/sdk";
import {
  planRecordDelete,
  applyRecordDelete,
  planRecordRestore,
  applyRecordRestore,
} from "@starkeep/shared-space-api";
import { createFileWatchManager, type FileWatchManager } from "../watcher.js";

const WATCH_ID = "w1";
const WATCHER_APP = "starkeep-drive";

interface Node {
  /** The watched directory. */
  dir: string;
  /** Where the database and the object store live. */
  root: string;
  rawDb: DatabaseSync;
  db: SqliteDatabaseAdapter;
  objects: FsObjectStorageAdapter;
  cloud: MockObjectStorageAdapter;
  residency: ResidencyManager;
  probes: ReplicaProbe[];
  sdk: StarkeepSdk;
  clock: HLCClock;
  /**
   * Shut the current manager down and start a fresh one over the same database,
   * object store and residency — one restart, and one pass over the directory.
   */
  restart(): Promise<FileWatchManager>;
  /** The manager started most recently. */
  watcher(): FileWatchManager;
  cleanup(): Promise<void>;
}

async function node(options: { keepOriginals?: boolean } = {}): Promise<Node> {
  const root = await mkdtemp(join(tmpdir(), "wtrack-root-"));
  const dir = await mkdtemp(join(tmpdir(), "wtrack-watch-"));
  const db = new SqliteDatabaseAdapter({
    path: join(root, "data.db"),
    driver: nodeSqliteDriver,
  });
  await db.init();
  const objects = new FsObjectStorageAdapter({ basePath: join(root, "objects") });
  await objects.init();
  const cloud = new MockObjectStorageAdapter();
  await cloud.init();

  const residency = createResidencyManager({
    localDb: db.getRawDatabase(),
    databaseAdapter: db,
    localObjectStorage: objects,
    isCloudNode: false,
    ceilings: DEFAULT_SYNC_DOWN_CEILINGS.desktop,
    ...(options.keepOriginals ? { keepOriginals: true } : {}),
    // The laptop's answer: a watched file is a symlink into the person's folder,
    // so the bytes are borrowed and removing the key frees nothing.
    borrowsBytes: (key) => objects.isAlias(key),
  });
  const probes: ReplicaProbe[] = [{ nodeId: "cloud", storage: cloud }];
  const clock = createHLCClock({ nodeId: "node-a" });
  const sdk = await createStarkeepSdk({
    databaseAdapter: db,
    objectStorageAdapter: objects,
    nodeId: "node-a",
    clock,
  });

  let current: FileWatchManager | null = null;
  const self: Node = {
    dir,
    root,
    rawDb: db.getRawDatabase() as unknown as DatabaseSync,
    db,
    objects,
    cloud,
    residency,
    probes,
    sdk,
    clock,
    async restart() {
      await current?.shutdown();
      current = createFileWatchManager({
        sdk,
        db: db.getRawDatabase(),
        databaseAdapter: db,
        objectStorageAdapter: objects,
        appId: WATCHER_APP,
        residency,
        probes: () => probes,
        standards: () => DEFAULT_STAND_IN_STANDARDS,
      });
      await current.startWatch({ id: WATCH_ID, directoryPath: dir, recursive: false });
      return current;
    },
    watcher() {
      if (!current) throw new Error("no watch started yet");
      return current;
    },
    async cleanup() {
      await current?.shutdown();
      await rm(dir, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    },
  };
  return self;
}

/** Put a record's bytes in the cloud with a checksum, so a copy can be proved. */
async function uploadToCloud(n: Node, recordId: string): Promise<void> {
  const record = (await n.db.get(recordId as StarkeepId))!;
  const bytes = (await n.objects.get(record.objectStorageKey))!.data;
  await n.cloud.put(record.objectStorageKey, bytes, {
    checksumSha256: createHash("sha256").update(bytes as unknown as Uint8Array).digest("base64"),
  });
}

/** Delete a record through the same planner every delete path uses. */
async function deleteRecord(n: Node, id: string): Promise<void> {
  const record = (await n.db.get(id as StarkeepId))!;
  const plan = await planRecordDelete(n.db, record);
  if (!plan.ok) throw new Error(String(plan.body.error));
  await applyRecordDelete(n.db, plan, n.clock);
}

/**
 * Restore a record the way a peer's restore arrives: the row changes and nothing
 * on this disk does.
 */
async function restoreRecord(n: Node, id: string): Promise<void> {
  const record = (await n.db.get(id as StarkeepId))!;
  const plan = await planRecordRestore(n.db, record);
  if (!plan.ok) throw new Error(String(plan.body.error));
  await applyRecordRestore(n.db, plan, n.clock);
}

function counts(mgr: FileWatchManager) {
  const s = mgr.getStatus(WATCH_ID)!;
  return { synced: s.syncedFiles, total: s.totalFiles };
}

function recordIdFor(mgr: FileWatchManager, filePath: string): string {
  return mgr.getWatchFiles(WATCH_ID).find((f) => f.filePath === filePath)!.dataRecordId;
}

/** The object store's own entry for a key, for asserting on the link itself. */
function entryPath(n: Node, key: string): string {
  return key.includes("/")
    ? join(n.root, "objects", key)
    : join(n.root, "objects", key.slice(0, 2), key);
}

describe("watch_files tracking table", () => {
  it("keys each file's tracking row by its own path (not the watch id)", async () => {
    // Regression: `upsertTrackingRecord` bound `file_path`/`watch_id` in swapped
    // order, so every file collided on the primary key and one row survived per
    // watch — while `loadTrackingRecords` (WHERE watch_id = ?) matched none.
    const n = await node();
    await writeFile(join(n.dir, "one.txt"), "content-one");
    await writeFile(join(n.dir, "two.txt"), "content-two");
    const mgr = await n.restart();

    const rows = n.rawDb
      .prepare("SELECT file_path, watch_id, library_state FROM watch_files ORDER BY file_path")
      .all() as { file_path: string; watch_id: string; library_state: string }[];
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.file_path)).toEqual([join(n.dir, "one.txt"), join(n.dir, "two.txt")]);
    expect(rows.every((r) => r.watch_id === WATCH_ID)).toBe(true);
    expect(rows.every((r) => r.library_state === "synced")).toBe(true);
    expect(counts(mgr)).toEqual({ synced: 2, total: 2 });

    await n.cleanup();
  });

  it("reloads tracking and restores missing local objects without duplicating records", async () => {
    const n = await node();
    await writeFile(join(n.dir, "a.txt"), "aaa");
    await writeFile(join(n.dir, "b.txt"), "bbb");
    const first = await n.restart();
    const before = first.getWatchFiles(WATCH_ID).map((f) => f.dataRecordId).sort();
    expect(before).toHaveLength(2);

    // A fresh local install can keep the record database and the watch table while
    // replacing the object directory. The watched source files are the authoritative
    // local bytes, so the restart restores their object links rather than trusting
    // the tracking row alone.
    await first.shutdown();
    await rm(join(n.root, "objects"), { recursive: true, force: true });
    await n.objects.init();

    const second = await n.restart();
    expect(counts(second)).toEqual({ synced: 2, total: 2 });
    expect(second.getWatchFiles(WATCH_ID).map((f) => f.dataRecordId).sort()).toEqual(before);
    for (const id of before) {
      const record = (await n.db.get(id as StarkeepId))!;
      expect(await n.objects.has(record.objectStorageKey)).toBe(true);
    }

    await n.cleanup();
  });

  it("does not strand a file as pending when its mtime moved but bytes did not", async () => {
    // The reported "7/8": after a restart, a file whose mtime advanced while the
    // server was down but whose content is identical must settle back to synced.
    // The buggy fast-path left it `pending` forever.
    const n = await node();
    const path = join(n.dir, "target.txt");
    await writeFile(path, "unchanged-bytes");
    const first = await n.restart();
    expect(counts(first)).toEqual({ synced: 1, total: 1 });
    const id = recordIdFor(first, path);

    const future = new Date(Date.now() + 30_000);
    await utimes(path, future, future);

    const second = await n.restart();
    expect(counts(second)).toEqual({ synced: 1, total: 1 });
    expect(recordIdFor(second, path)).toBe(id);

    await n.cleanup();
  });
});

describe("a file leaving a watched folder", () => {
  it("evicts rather than deletes once the cloud copy is proved", async () => {
    const n = await node();
    const path = join(n.dir, "proved.txt");
    await writeFile(path, "bytes-with-a-cloud-copy");
    const first = await n.restart();
    const id = recordIdFor(first, path);
    await uploadToCloud(n, id);
    const key = (await n.db.get(id as StarkeepId))!.objectStorageKey;

    await unlink(path);
    const after = await n.restart();

    // The record is untouched. A tombstone here would travel to the cloud and to
    // every other node, so a backup machine whose folder was cleaned would delete
    // the library's only remaining copy of its own backup.
    expect((await n.db.get(id as StarkeepId))!.deletedAt).toBeNull();
    // This node's copy of the bytes is gone, and residency says so. The symlink is
    // removed rather than left dangling, so a later on-demand fetch writes a regular
    // file and `resolvePath` never names a path that is not there.
    expect(await n.objects.has(key)).toBe(false);
    expect(await n.objects.resolvePath(key)).toBeNull();
    expect(n.residency.wasEvicted(key)).toBe(true);
    expect(after.getStatus(WATCH_ID)!.evicted).toEqual([path]);
    expect(after.getStatus(WATCH_ID)!.possiblyLost).toEqual([]);
    // And the bytes are still readable, from the cloud, which is the whole content
    // of the promise `evicted` makes.
    expect((await n.cloud.get(key))!.data.toString()).toBe("bytes-with-a-cloud-copy");

    await n.cleanup();
  });

  it("changes nothing on disk and reports the file when no cloud copy is proved", async () => {
    // The one new way a person can lose data, and the reason it is reported rather
    // than stated as a state: unlinking a link whose target is already gone would
    // destroy the last reference to the content.
    const n = await node();
    const path = join(n.dir, "unproved.txt");
    await writeFile(path, "bytes-nowhere-else");
    const first = await n.restart();
    const id = recordIdFor(first, path);
    const key = (await n.db.get(id as StarkeepId))!.objectStorageKey;

    await unlink(path);
    const after = await n.restart();

    expect((await n.db.get(id as StarkeepId))!.deletedAt).toBeNull();
    expect((await lstat(entryPath(n, key))).isSymbolicLink()).toBe(true);
    expect(n.residency.wasEvicted(key)).toBe(false);
    expect(after.getStatus(WATCH_ID)!.possiblyLost).toEqual([path]);
    expect(after.getStatus(WATCH_ID)!.evicted).toEqual([]);

    await n.cleanup();
  });

  it("leaves an evicted key alone on the acquisition pass, even keeping originals", async () => {
    // The gap eviction had: `considerForAcquisition` asked the policy and nothing
    // else, and a node with `keepOriginals` set wants every original — so the file
    // the person just deleted came straight back down.
    const n = await node({ keepOriginals: true });
    const path = join(n.dir, "kept-originals.jpg");
    await writeFile(path, "jpeg-ish-bytes");
    const first = await n.restart();
    const id = recordIdFor(first, path);
    await uploadToCloud(n, id);
    const record = (await n.db.get(id as StarkeepId))!;

    await unlink(path);
    await n.restart();
    expect(n.residency.wasEvicted(record.objectStorageKey)).toBe(true);

    const candidate = blobCandidateForRecord((await n.db.get(id as StarkeepId))!)!;
    expect(await n.residency.considerForAcquisition(candidate)).toBe("unwanted");
    expect(n.residency.deferredCandidates(10)).toEqual([]);

    await n.cleanup();
  });

  it("repairs the dangling link when the file comes back", async () => {
    // `putSymlink` swallowed EEXIST on the reasoning that a content-addressed key
    // guarantees identical content. It does — of the content, and not of a link's
    // target, so `ensureLocalObject` reported "Restored watched object" over a link
    // that still pointed at nothing and the watcher could never fix it.
    const n = await node();
    const path = join(n.dir, "returning.txt");
    await writeFile(path, "bytes-that-return");
    const first = await n.restart();
    const id = recordIdFor(first, path);
    const key = (await n.db.get(id as StarkeepId))!.objectStorageKey;

    // The unproved branch leaves the link in place with its target gone, which is
    // the state this repair exists for.
    await unlink(path);
    await n.restart();
    expect(await n.objects.has(key)).toBe(false);
    expect((await lstat(entryPath(n, key))).isSymbolicLink()).toBe(true);

    await writeFile(path, "bytes-that-return");
    const back = await n.restart();

    expect(await n.objects.has(key)).toBe(true);
    expect((await n.objects.get(key))!.data.toString()).toBe("bytes-that-return");
    expect(back.getStatus(WATCH_ID)!.possiblyLost).toEqual([]);
    expect(counts(back)).toEqual({ synced: 1, total: 1 });

    await n.cleanup();
  });
});

describe('"Free up space" over a watched folder', () => {
  it("skips a symlinked key rather than spending a removal on zero bytes", async () => {
    // A watched file is linked into the object store, so its bytes belong to the
    // person's folder: removing the key frees nothing and loses the link. The hook
    // that says so was wired on the phone only.
    const n = await node();
    const path = join(n.dir, "linked.jpg");
    await writeFile(path, "a".repeat(8 * 1024 * 1024));
    const first = await n.restart();
    const id = recordIdFor(first, path);
    await uploadToCloud(n, id);
    const key = (await n.db.get(id as StarkeepId))!.objectStorageKey;

    const report = await n.residency.freeUpSpace({
      bytes: 100 * 1024 * 1024,
      scope: "originals-and-above-ceiling",
      probes: n.probes,
    });
    expect(report.removed.map((r) => r.recordId)).not.toContain(id);
    expect(report.freedBytes).toBe(0);
    expect(await n.objects.has(key)).toBe(true);

    await n.cleanup();
  });
});

describe("a record the person deleted", () => {
  it("is not re-ingested while its file is still on disk", async () => {
    // Resurrection, which defeated every other deletion behaviour. A record id is a
    // pure function of parent, filename and content hash, so re-ingesting the same
    // file writes the tombstoned row's own id — and `put` upserts every column, so a
    // single call was the whole resurrection with no second write to catch.
    const n = await node();
    const path = join(n.dir, "deleted.txt");
    await writeFile(path, "bytes-the-person-deleted");
    const first = await n.restart();
    const id = recordIdFor(first, path);

    await deleteRecord(n, id);
    const after = await n.restart();

    const record = (await n.db.get(id as StarkeepId))!;
    expect(record.deletedAt).not.toBeNull();
    // Still the delete's own clock reading. A resurrection is a `put`, which would
    // have moved `updated_at` forward and cleared `deleted_at` in the same write —
    // one call was the whole bug.
    expect(record.updatedAt).toEqual(record.deletedAt);
    expect(after.getStatus(WATCH_ID)!.excluded).toEqual([path]);
    expect(counts(after)).toEqual({ synced: 0, total: 1 });

    // And a touch does not change the verdict: the mark is cleared by new *bytes*,
    // which would be a new file and a new id, not by a new mtime.
    const future = new Date(Date.now() + 30_000);
    await utimes(path, future, future);
    const touched = await n.restart();
    expect((await n.db.get(id as StarkeepId))!.deletedAt).not.toBeNull();
    expect(touched.getStatus(WATCH_ID)!.excluded).toEqual([path]);

    await n.cleanup();
  });

  it("ingests new bytes at an excluded path, because they are a new file", async () => {
    const n = await node();
    const path = join(n.dir, "replaced.txt");
    await writeFile(path, "the-deleted-bytes");
    const first = await n.restart();
    const deletedId = recordIdFor(first, path);
    await deleteRecord(n, deletedId);
    const excluded = await n.restart();
    expect(excluded.getStatus(WATCH_ID)!.excluded).toEqual([path]);

    await writeFile(path, "entirely-different-bytes");
    const after = await n.restart();

    const freshId = recordIdFor(after, path);
    expect(freshId).not.toBe(deletedId);
    expect((await n.db.get(freshId as StarkeepId))!.deletedAt).toBeNull();
    expect((await n.db.get(deletedId as StarkeepId))!.deletedAt).not.toBeNull();
    expect(after.getStatus(WATCH_ID)!.excluded).toEqual([]);

    await n.cleanup();
  });

  it("comes back at its original id, with its labels live again", async () => {
    const n = await node();
    const path = join(n.dir, "added-back.txt");
    await writeFile(path, "bytes-coming-back");
    const first = await n.restart();
    const id = recordIdFor(first, path);

    await n.db.upsertLabels([
      {
        recordId: id as StarkeepId,
        appId: "photos",
        key: "favourite",
        value: "",
        recordType: (await n.db.get(id as StarkeepId))!.type,
        hlc: n.clock.now(),
      },
    ]);
    await deleteRecord(n, id);
    const excluded = await n.restart();
    expect(excluded.getStatus(WATCH_ID)!.excluded).toEqual([path]);
    expect(
      (await n.db.getLabelsByRecordIds([id as StarkeepId])).get(id as StarkeepId) ?? [],
    ).toEqual([]);

    const outcome = await excluded.addBack(path);
    // The same id, not a copy: the id names the content, which is what makes the
    // way back exact rather than a second item that looks the same.
    expect(outcome).toEqual({ ok: true, recordId: id });

    const record = (await n.db.get(id as StarkeepId))!;
    expect(record.deletedAt).toBeNull();
    const labels = (await n.db.getLabelsByRecordIds([id as StarkeepId])).get(id as StarkeepId);
    expect(labels?.map((l) => l.key)).toEqual(["favourite"]);
    expect(excluded.getStatus(WATCH_ID)!.excluded).toEqual([]);
    // The bytes are linked again, from the file that never left.
    expect(await n.objects.has(record.objectStorageKey)).toBe(true);

    await n.cleanup();
  });

  it("refuses an add-back for a path that is not excluded", async () => {
    const n = await node();
    const path = join(n.dir, "live.txt");
    await writeFile(path, "still-in-the-library");
    const mgr = await n.restart();

    expect(await mgr.addBack(path)).toMatchObject({ ok: false, status: 409 });
    expect(await mgr.addBack(join(n.dir, "never-seen.txt"))).toMatchObject({
      ok: false,
      status: 404,
    });

    await n.cleanup();
  });
});

describe("a record deleted or restored somewhere else", () => {
  it("marks the path excluded without a filesystem event or a restart", async () => {
    // Another node's delete changes nothing on this disk, so the ingest guard —
    // which runs on an FS event or a scan — never sees it. The watch status read
    // `synced` for a record the library had deleted until the next restart.
    const n = await node();
    const path = join(n.dir, "deleted-elsewhere.txt");
    await writeFile(path, "bytes-deleted-on-another-node");
    const mgr = await n.restart();
    const id = recordIdFor(mgr, path);

    await deleteRecord(n, id);
    // The stale reading the recheck exists to close.
    expect(mgr.getStatus(WATCH_ID)!.excluded).toEqual([]);
    expect(counts(mgr)).toEqual({ synced: 1, total: 1 });

    await mgr.recheckRecords([id]);

    expect(mgr.getStatus(WATCH_ID)!.excluded).toEqual([path]);
    expect(counts(mgr)).toEqual({ synced: 0, total: 1 });
    // Written down, not just held: the mark is the one thing in this table that
    // cannot be re-derived from the disk.
    const row = n.rawDb
      .prepare("SELECT library_state FROM watch_files WHERE file_path = ?")
      .get(path) as { library_state: string };
    expect(row.library_state).toBe("deleted-from-library");

    await n.cleanup();
  });

  it("puts the file back when the restore arrives from somewhere else", async () => {
    // The direction that was stuck for good: the ingest guard returns early for an
    // excluded path whose bytes have not changed, and `addBack` answered 409 because
    // the record was already live. Identical bytes made touching the file useless
    // too, so the only way out was to remove the watch and add it again.
    const n = await node();
    const path = join(n.dir, "restored-elsewhere.txt");
    await writeFile(path, "bytes-coming-back-from-a-peer");
    const mgr = await n.restart();
    const id = recordIdFor(mgr, path);
    const key = (await n.db.get(id as StarkeepId))!.objectStorageKey;

    await deleteRecord(n, id);
    await mgr.recheckRecords([id]);
    expect(mgr.getStatus(WATCH_ID)!.excluded).toEqual([path]);

    await restoreRecord(n, id);
    // The link gone as well, so the assertion below proves the re-ingest ran
    // rather than finding work already done.
    await n.objects.delete(key);

    await mgr.recheckRecords([id]);

    expect(mgr.getStatus(WATCH_ID)!.excluded).toEqual([]);
    expect(counts(mgr)).toEqual({ synced: 1, total: 1 });
    expect(recordIdFor(mgr, path)).toBe(id);
    expect(await n.objects.has(key)).toBe(true);

    await n.cleanup();
  });

  it("leaves an evicted path alone, because its file is not on disk", async () => {
    // `evicted` and `possibly-lost` are not statements about the library's opinion
    // of the record, and there is no file to exclude or to re-link.
    const n = await node();
    const path = join(n.dir, "gone-then-deleted.txt");
    await writeFile(path, "bytes-with-a-cloud-copy");
    const first = await n.restart();
    const id = recordIdFor(first, path);
    await uploadToCloud(n, id);
    await unlink(path);
    const mgr = await n.restart();
    expect(mgr.getStatus(WATCH_ID)!.evicted).toEqual([path]);

    await deleteRecord(n, id);
    await mgr.recheckRecords([id]);

    expect(mgr.getStatus(WATCH_ID)!.evicted).toEqual([path]);
    expect(mgr.getStatus(WATCH_ID)!.excluded).toEqual([]);

    await n.cleanup();
  });

  it("ignores record ids this watcher does not track", async () => {
    const n = await node();
    await writeFile(join(n.dir, "untouched.txt"), "bytes");
    const mgr = await n.restart();

    await mgr.recheckRecords(["01ZZZZZZZZZZZZZZZZZZZZZZZZ"]);
    await mgr.recheckRecords([]);

    expect(counts(mgr)).toEqual({ synced: 1, total: 1 });

    await n.cleanup();
  });
});

describe("adding back a record that is already live", () => {
  it("succeeds instead of refusing the restore it does not need", async () => {
    // The manual way back has to work when no round announced the restore: a
    // notification can be missed, and `planRecordRestore` refuses a live record.
    const n = await node();
    const path = join(n.dir, "restored-behind-our-back.txt");
    await writeFile(path, "bytes-restored-elsewhere");
    const mgr = await n.restart();
    const id = recordIdFor(mgr, path);
    const key = (await n.db.get(id as StarkeepId))!.objectStorageKey;

    await deleteRecord(n, id);
    await mgr.recheckRecords([id]);
    expect(mgr.getStatus(WATCH_ID)!.excluded).toEqual([path]);

    // The restore lands with no recheck behind it, which is the state the person's
    // "add back" click meets.
    await restoreRecord(n, id);
    await n.objects.delete(key);

    expect(await mgr.addBack(path)).toEqual({ ok: true, recordId: id });
    expect(mgr.getStatus(WATCH_ID)!.excluded).toEqual([]);
    expect(await n.objects.has(key)).toBe(true);

    await n.cleanup();
  });
});
