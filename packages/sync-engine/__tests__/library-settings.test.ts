import { beforeEach, describe, expect, it } from "vitest";
import {
  createDataRecord,
  createHLCClock,
  DEFAULT_STAND_IN_STANDARDS as STD,
  serializeUserSettings,
  SETTINGS_TYPE_ID,
  USER_SETTINGS_FILE_NAME,
  type UserSettings,
} from "@starkeep/protocol-primitives";
import { MockDatabaseAdapter, MockObjectStorageAdapter } from "@starkeep/storage-adapter";
import { createLibrarySettings } from "../src/library-settings.js";

let t = 1;
const clock = createHLCClock({ nodeId: "A", wallClockFunction: () => t++ });
let db: MockDatabaseAdapter;
let storage: MockObjectStorageAdapter;

beforeEach(async () => {
  db = new MockDatabaseAdapter();
  storage = new MockObjectStorageAdapter();
  await db.init();
  await storage.init();
});

async function writeSettings(settings: UserSettings | Uint8Array, hash: string, withBytes = true) {
  const bytes = settings instanceof Uint8Array ? settings : serializeUserSettings(settings);
  const key = `shared/starkeep/00/${hash}`;
  if (withBytes) await storage.put(key, bytes);
  const record = createDataRecord(
    {
      type: SETTINGS_TYPE_ID,
      originAppId: "starkeep-drive",
      contentHash: hash,
      objectStorageKey: key,
      sizeBytes: bytes.byteLength,
      originalFilename: USER_SETTINGS_FILE_NAME,
    },
    clock,
  );
  await db.put(record);
  return record;
}

const source = (cloudConfigured: boolean) =>
  createLibrarySettings({ db, storage, clock, cloudConfigured: () => cloudConfigured });

describe("createLibrarySettings", () => {
  it("knows the defaults are the value when no settings file exists, cloud or not", async () => {
    // The person has not set a value, so the defaults are the library's value
    // and there is nothing to wait for. A host that treated this as unknown
    // would leave every original in an untouched library waiting on the cloud
    // before any app could derive a stand-in for it.
    const withCloud = source(true);
    await withCloud.refresh();
    expect(withCloud.standards()).toEqual(STD);
    expect(withCloud.knowsLibraryValue()).toBe(true);
    expect(withCloud.status()).toMatchObject({ set: false, recordId: null });

    const alone = source(false);
    await alone.refresh();
    expect(alone.knowsLibraryValue()).toBe(true);
  });

  it("reads the winning file and knows its value", async () => {
    const record = await writeSettings({ standIns: { image: { canonicalThreshold: 6000 } } }, "a");
    const settings = source(true);
    await settings.refresh();
    expect(settings.standards().image.canonicalThreshold).toBe(6000);
    expect(settings.knowsLibraryValue()).toBe(true);
    expect(settings.status()).toMatchObject({ set: true, recordId: record.id, problems: [] });
  });

  it("tombstones every live settings file but the newest", async () => {
    const older = await writeSettings({ standIns: { image: { canonicalThreshold: 6000 } } }, "a");
    await writeSettings({ standIns: { image: { canonicalThreshold: 3200 } } }, "b");
    const settings = source(true);
    const tombstones = await settings.refresh();
    expect(tombstones.map((r) => r.id)).toEqual([older.id]);
    expect((await db.get(older.id))!.deletedAt).not.toBeNull();
    expect(settings.standards().image.canonicalThreshold).toBe(3200);
  });

  it("leaves losers alone when asked to", async () => {
    const older = await writeSettings({}, "a");
    await writeSettings({ standIns: { image: { canonicalThreshold: 3200 } } }, "b");
    expect(await source(true).refresh({ tombstoneLosers: false })).toEqual([]);
    expect((await db.get(older.id))!.deletedAt).toBeNull();
  });

  it("does not know the value while the file's bytes are missing or do not parse", async () => {
    await writeSettings({ standIns: { image: { canonicalThreshold: 6000 } } }, "a", false);
    const settings = source(true);
    await settings.refresh();
    expect(settings.knowsLibraryValue()).toBe(false);
    expect(settings.standards()).toEqual(STD);
    expect(settings.status().problems.join()).toMatch(/not reached this machine/);

    await writeSettings(new TextEncoder().encode("{broken"), "b");
    await settings.refresh();
    expect(settings.knowsLibraryValue()).toBe(false);
    expect(settings.status().problems.join()).toMatch(/not valid JSON/);
  });

  it("reads the file again only when the winner changes", async () => {
    await writeSettings({ standIns: { image: { canonicalThreshold: 6000 } } }, "a");
    let reads = 0;
    const counting = { get: async (key: string) => (reads++, storage.get(key)) };
    const settings = createLibrarySettings({ cloudConfigured: () => true });
    await settings.refresh({ db, storage: counting, clock });
    await settings.refresh({ db, storage: counting, clock });
    expect(reads).toBe(1);
    await writeSettings({ standIns: { image: { canonicalThreshold: 3200 } } }, "b");
    await settings.refresh({ db, storage: counting, clock });
    expect(reads).toBe(2);
    expect(settings.standards().image.canonicalThreshold).toBe(3200);
  });
});
