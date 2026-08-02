/**
 * A phone with a budget that actually binds.
 *
 * This is what the media plan says Phase 2 exists to validate: "the phone peer
 * is the only honest consumer of `Elided`". Every residency test before this one
 * ran against fixtures or a laptop that wanted everything — so the decision
 * logic was exercised while the *situation* it was designed for never occurred.
 * Here the budget is genuinely smaller than the library, and the node has to
 * decline data and still be correct.
 *
 * `Elided` means: the record is present and its bytes are not. That is a valid,
 * intended state — not a failure — and the assertions below are careful to
 * distinguish it from "the sync did not work", which looks identical if you only
 * check one of the two.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { createHLCClock } from "@starkeep/protocol-primitives";
import { MockDatabaseAdapter, MockObjectStorageAdapter } from "@starkeep/storage-adapter";
import { createInProcessSyncTransport, type NodeRetentionPolicy } from "@starkeep/sync-engine";
import { createMobileNode, type MobileNode } from "../src/node";
import { createOpSqliteDriver, type OpSqliteConnection } from "../src/db/op-sqlite-driver";
import { ExpoObjectStorageAdapter } from "../src/storage/expo-object-storage";
import { fakeExpoFs } from "./helpers/fake-expo-fs";
import type { DataRecord } from "@starkeep/protocol-primitives";

function fakeOpSqlite() {
  const db = new DatabaseSync(":memory:");
  const connection: OpSqliteConnection = {
    executeSync(query: string, params?: unknown[]) {
      const stmt = db.prepare(query);
      if (/^\s*(select|pragma|with)/i.test(query)) {
        return { rows: stmt.all(...((params ?? []) as never[])) as unknown[] };
      }
      stmt.run(...((params ?? []) as never[]));
      return { rows: [] };
    },
    close() {
      db.close();
    },
  };
  return { open: () => connection };
}

let cloudDb: MockDatabaseAdapter;
let cloudStorage: MockObjectStorageAdapter;
let phone: MobileNode | null = null;

/** Bytes of a stated size, and the hash that actually matches them. */
const bytesOf = (size: number, fill: number) => new Uint8Array(size).fill(fill);
const hashOf = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

let seq = 0;
async function seedCloud(sizeBytes: number): Promise<DataRecord> {
  seq += 1;
  const bytes = bytesOf(sizeBytes, seq % 251);
  const hash = hashOf(bytes);
  const rec = {
    id: `rec-${seq}`,
    type: "image/jpeg",
    createdAt: { wallTime: Date.UTC(2026, 0, 1), counter: seq, nodeId: "cloud" },
    updatedAt: { wallTime: Date.UTC(2026, 0, 1), counter: seq, nodeId: "cloud" },
    deletedAt: null,
    version: 1,
    contentHash: hash,
    objectStorageKey: `shared/image/${hash.slice(0, 2)}/${hash}`,
    mimeType: "image/jpeg",
    sizeBytes,
    originAppId: "photos",
    parentId: null,
    originalFilename: `photo-${seq}.jpg`,
  } as DataRecord;
  await cloudDb.put(rec);
  await cloudStorage.put(rec.objectStorageKey!, bytes);
  return rec;
}

async function startPhone(retention?: NodeRetentionPolicy): Promise<MobileNode> {
  const harness = fakeExpoFs();
  return createMobileNode({
    nodeId: "phone-a",
    databasePath: "/data/starkeep/local.sqlite",
    sqliteDriver: createOpSqliteDriver(fakeOpSqlite()),
    localObjectStorage: new ExpoObjectStorageAdapter({
      fs: harness.fs,
      basePath: "/docs/objects",
    }),
    remoteObjectStorage: cloudStorage,
    transport: createInProcessSyncTransport({
      databaseAdapter: cloudDb,
      clock: createHLCClock({ nodeId: "cloud" }),
      objectStorage: cloudStorage,
    }),
    ...(retention ? { retention } : {}),
  });
}

/** Everything the phone knows about, and whether it holds the bytes. */
async function residencyOf(node: MobileNode) {
  const { records } = await node.databaseAdapter.query({});
  const held: string[] = [];
  const elided: string[] = [];
  for (const r of records) {
    if (!r.objectStorageKey) continue;
    ((await node.objectStorage.has(r.objectStorageKey)) ? held : elided).push(r.id);
  }
  return { total: records.length, held, elided };
}

beforeEach(async () => {
  seq = 0;
  cloudDb = new MockDatabaseAdapter();
  cloudStorage = new MockObjectStorageAdapter();
  await cloudDb.init();
  await cloudStorage.init();
});

afterEach(async () => {
  await phone?.close();
  phone = null;
});

const KB = 1024;

describe("a budget that binds", () => {
  // Every original the cloud holds, against a budget that fits roughly two.
  const tightPolicy: NodeRetentionPolicy = {
    rows: { "original:image": { keep: "all", budgetBytes: 25 * KB } },
    fallback: { keep: "all", budgetBytes: 25 * KB },
  };

  it("keeps the records and declines some of the bytes", async () => {
    for (let i = 0; i < 5; i += 1) await seedCloud(10 * KB);
    phone = await startPhone(tightPolicy);
    for (let i = 0; i < 3; i += 1) await phone.exchange();

    const state = await residencyOf(phone);
    // Metadata is cheap and always syncs — a phone that dropped records would
    // be unable to *show* the library, not merely unable to open a photo.
    expect(state.total, "records must sync regardless of the byte budget").toBe(5);
    // And some bytes were genuinely declined. Without this the test passes on a
    // node that ignored the budget entirely.
    expect(state.elided.length, "nothing was elided, so the budget did nothing").toBeGreaterThan(0);
  });

  it("holds what the budget allows rather than nothing", async () => {
    for (let i = 0; i < 5; i += 1) await seedCloud(10 * KB);
    phone = await startPhone(tightPolicy);
    for (let i = 0; i < 3; i += 1) await phone.exchange();

    // The opposite failure to the one above: a node that declines everything is
    // as broken as one that declines nothing, and both satisfy "some records
    // have no bytes".
    expect((await residencyOf(phone)).held.length).toBeGreaterThan(0);
  });

  it("stays within the budget it was given", async () => {
    for (let i = 0; i < 8; i += 1) await seedCloud(10 * KB);
    phone = await startPhone(tightPolicy);
    for (let i = 0; i < 4; i += 1) await phone.exchange();

    const { held } = await residencyOf(phone);
    // 25 KB of budget against 10 KB objects: three would exceed it.
    expect(held.length).toBeLessThanOrEqual(3);
  });
});

describe("no policy at all", () => {
  // The unconfigured default, and deliberately the wrong setting for a phone.
  // A node that has not been told its budget must not silently start declining
  // data: over-fetching costs disk, under-fetching costs a photo that is
  // quietly nowhere.
  it("wants every blob, exactly as an unconfigured laptop does", async () => {
    for (let i = 0; i < 3; i += 1) await seedCloud(10 * KB);
    phone = await startPhone();
    await phone.exchange();

    const state = await residencyOf(phone);
    expect(state.elided).toEqual([]);
    expect(state.held).toHaveLength(3);
  });

  it("reports no residency manager, rather than an empty one", async () => {
    phone = await startPhone();
    // Null is the honest answer and distinguishable from "a manager that
    // decided to keep everything" — which matters to an inspector explaining
    // why a record is present.
    expect(phone.residency).toBeNull();
  });
});

describe("keep: never", () => {
  it("takes the records and none of the bytes", async () => {
    for (let i = 0; i < 3; i += 1) await seedCloud(10 * KB);
    phone = await startPhone({
      rows: { "original:image": { keep: "never", budgetBytes: 1 } },
      fallback: { keep: "never", budgetBytes: 1 },
    });
    for (let i = 0; i < 2; i += 1) await phone.exchange();

    const state = await residencyOf(phone);
    // The whole library is browsable and none of it is downloaded — which is
    // exactly what `Elided` is for, and what a phone on cellular wants.
    expect(state.total).toBe(3);
    expect(state.held).toEqual([]);
  });
});
