/**
 * Binding a library to its user: the `local` segment becomes the user's id on
 * disk and in every stored key, once, before the first sync. A real SDK writes
 * the records and bytes, so the keys under test are the keys the server makes.
 *
 * See `~/projects/starkeep/plan-multi-user-roles-2026-10-16.md`, step 4.9.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHLCClock, LOCAL_USER_SEGMENT } from "@starkeep/protocol-primitives";
import { SqliteDatabaseAdapter } from "@starkeep/storage-sqlite";
import { FsObjectStorageAdapter } from "@starkeep/storage-fs";
import { createStarkeepSdk, type StarkeepSdk } from "@starkeep/sdk";
import type { RawDatabase } from "@starkeep/storage-adapter";
import { nodeSqliteDriver } from "../../../packages/storage-sqlite/src/node-driver.js";
import {
  bindLibrary,
  boundUserId,
  libraryUserSegment,
  LibraryBoundElsewhereError,
} from "../library-binding.js";

const USER = "8f1c2d3e-0000-4000-8000-000000000001";
const FILE_INDEX = "memo_syncable__starkeep_sync_records";

interface Library {
  readonly db: RawDatabase;
  readonly objectsDir: string;
  readonly sdk: StarkeepSdk;
}

let lib: Library;
let segment: string;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "bind-"));
  const adapter = new SqliteDatabaseAdapter({
    path: join(root, "data.db"),
    driver: nodeSqliteDriver,
  });
  await adapter.init();
  const objectsDir = join(root, "objects");
  const objects = new FsObjectStorageAdapter({ basePath: objectsDir });
  await objects.init();
  const db = adapter.getRawDatabase();
  segment = libraryUserSegment(db);
  const sdk = await createStarkeepSdk({
    databaseAdapter: adapter,
    objectStorageAdapter: objects,
    nodeId: "node-a",
    clock: createHLCClock({ nodeId: "node-a" }),
    userId: () => segment,
  });
  // An app's file index, as the installer makes one: the full key is the row id.
  db.exec(`CREATE TABLE ${FILE_INDEX} (id TEXT PRIMARY KEY, object_storage_key TEXT NOT NULL)`);
  lib = { db, objectsDir, sdk };
});

/** Write a Memo-style app file under the current segment: bytes and index row. */
async function putAppFile(name: string): Promise<string> {
  const key = `apps/memo/${segment}/syncable/media/${name}`;
  await mkdir(join(lib.objectsDir, "apps", "memo", segment, "syncable", "media"), {
    recursive: true,
  });
  await writeFile(join(lib.objectsDir, key), name);
  lib.db.prepare(`INSERT INTO ${FILE_INDEX} (id, object_storage_key) VALUES (?, ?)`).run(key, key);
  return key;
}

function indexKeys(): string[] {
  return (
    lib.db.prepare(`SELECT id FROM ${FILE_INDEX} ORDER BY id`).all() as Array<{ id: string }>
  ).map((r) => r.id);
}

describe("bindLibrary", () => {
  it("starts unbound, writing under the local segment", async () => {
    expect(boundUserId(lib.db)).toBeNull();
    const record = await lib.sdk.data.putWithFile(
      { type: "image/jpeg", originAppId: "test" },
      Buffer.from("a"),
      "image/jpeg",
    );
    expect(record.objectStorageKey).toMatch(/^shared\/local\/image\//);
  });

  it("moves shared and app files to the user's segment and rewrites every stored key", async () => {
    const record = await lib.sdk.data.putWithFile(
      { type: "image/jpeg", originAppId: "test" },
      Buffer.from("a"),
      "image/jpeg",
    );
    const appKey = await putAppFile("one.mp3");

    const report = bindLibrary(lib.db, lib.objectsDir, USER);
    segment = libraryUserSegment(lib.db);

    expect(report).toMatchObject({ userId: USER, movedDirs: 2 });
    expect(boundUserId(lib.db)).toBe(USER);
    const rebound = await lib.sdk.data.get(record.id);
    expect(rebound!.objectStorageKey).toBe(
      record.objectStorageKey!.replace("shared/local/", `shared/${USER}/`),
    );
    expect(existsSync(join(lib.objectsDir, rebound!.objectStorageKey!))).toBe(true);
    expect(existsSync(join(lib.objectsDir, "shared", LOCAL_USER_SEGMENT))).toBe(false);
    expect(indexKeys()).toEqual([appKey.replace("/local/", `/${USER}/`)]);
    expect(
      existsSync(join(lib.objectsDir, "apps", "memo", USER, "syncable", "media", "one.mp3")),
    ).toBe(true);
  });

  it("sweeps a write that landed under local after binding", async () => {
    bindLibrary(lib.db, lib.objectsDir, USER);
    // A write that built its key before the pass and finished after it.
    segment = LOCAL_USER_SEGMENT;
    await putAppFile("late.mp3");
    segment = USER;
    await putAppFile("early.mp3");

    bindLibrary(lib.db, lib.objectsDir, USER);

    expect(indexKeys()).toEqual([
      `apps/memo/${USER}/syncable/media/early.mp3`,
      `apps/memo/${USER}/syncable/media/late.mp3`,
    ]);
    expect(
      existsSync(join(lib.objectsDir, "apps", "memo", USER, "syncable", "media", "late.mp3")),
    ).toBe(true);
    expect(existsSync(join(lib.objectsDir, "apps", "memo", LOCAL_USER_SEGMENT))).toBe(false);
  });

  it("drops a local row whose key already exists under the user, instead of failing", async () => {
    bindLibrary(lib.db, lib.objectsDir, USER);
    segment = USER;
    await putAppFile("dup.mp3");
    segment = LOCAL_USER_SEGMENT;
    await putAppFile("dup.mp3");

    expect(() => bindLibrary(lib.db, lib.objectsDir, USER)).not.toThrow();
    expect(indexKeys()).toEqual([`apps/memo/${USER}/syncable/media/dup.mp3`]);
  });

  it("refuses a second user and changes nothing", async () => {
    bindLibrary(lib.db, lib.objectsDir, USER);
    segment = LOCAL_USER_SEGMENT;
    const key = await putAppFile("kept.mp3");

    expect(() => bindLibrary(lib.db, lib.objectsDir, "another-user")).toThrow(
      LibraryBoundElsewhereError,
    );
    expect(boundUserId(lib.db)).toBe(USER);
    expect(indexKeys()).toEqual([key]);
  });

  it("refuses the local segment and malformed ids as a user", () => {
    expect(() => bindLibrary(lib.db, lib.objectsDir, LOCAL_USER_SEGMENT)).toThrow();
    expect(() => bindLibrary(lib.db, lib.objectsDir, "../x")).toThrow();
    expect(boundUserId(lib.db)).toBeNull();
  });
});
