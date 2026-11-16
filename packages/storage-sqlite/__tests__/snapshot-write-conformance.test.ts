/**
 * The sync apply path's writes, `putSnapshot` and `putLabel`, run against
 * every adapter that can be run offline.
 *
 * Both decide last-writer-wins inside the write: an existing row is replaced
 * only by a strictly later `updatedAt`. The apply paths compare in JavaScript
 * first, but that read and the write are separate transactions, and an
 * unconditional upsert let a concurrent older write overwrite a newer one
 * (`specs/exchange-round`, finding 3). These tests pin the guard on both the
 * mock and SQLite, because the sync engine's tests run against the mock.
 *
 * DSQL cannot join in offline. Its statement carries the same guard, pinned in
 * `storage-aurora-dsql/__tests__`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createDataRecord,
  createHLCClock,
  createStarkeepId,
  type DataRecord,
  type HLCClock,
  type RecordLabel,
} from "@starkeep/protocol-primitives";
import { MockDatabaseAdapter, type DatabaseAdapter } from "@starkeep/storage-adapter";
import { SqliteDatabaseAdapter } from "../src/adapter.js";
import { nodeSqliteDriver } from "../src/node-driver.js";

interface Backend {
  name: string;
  create: () => Promise<DatabaseAdapter>;
}

const backends: Backend[] = [
  {
    name: "MockDatabaseAdapter",
    create: async () => {
      const adapter = new MockDatabaseAdapter();
      await adapter.init();
      return adapter;
    },
  },
  {
    name: "SqliteDatabaseAdapter",
    create: async () => {
      const adapter = new SqliteDatabaseAdapter({ path: ":memory:", driver: nodeSqliteDriver });
      await adapter.init();
      return adapter;
    },
  },
];

describe.each(backends)("snapshot writes — $name", (backend) => {
  let adapter: DatabaseAdapter;
  let clock: HLCClock;
  let tick: number;

  const id = createStarkeepId("01J00000000000000000000001");

  beforeEach(async () => {
    adapter = await backend.create();
    tick = 0;
    clock = createHLCClock({ nodeId: "nodeA", wallClockFunction: () => 1000 + tick++ });
  });

  afterEach(async () => {
    await adapter.close();
  });

  function record(): DataRecord {
    return {
      ...createDataRecord(
        {
          type: "image/jpeg",
          originAppId: "photos",
          contentHash: "sha256:x",
          objectStorageKey: "",
          mimeType: "application/octet-stream",
          sizeBytes: 0,
        },
        clock,
      ),
      id,
    };
  }

  function label(deleted = false): RecordLabel {
    const at = clock.now();
    return {
      recordId: id,
      appId: "photos",
      key: "faces",
      value: "Alice",
      recordType: "image/jpeg",
      createdAt: at,
      updatedAt: at,
      nodeId: at.nodeId,
      deletedAt: deleted ? at : null,
    };
  }

  it("putSnapshot writes a new row and a newer version", async () => {
    const older = record();
    expect(await adapter.putSnapshot(older)).toBe(true);
    const newer = { ...older, updatedAt: clock.now(), version: older.version + 1 };
    expect(await adapter.putSnapshot(newer)).toBe(true);
    expect((await adapter.get(id))!.updatedAt).toEqual(newer.updatedAt);
  });

  it("putSnapshot keeps a newer row rather than writing an older one over it", async () => {
    const older = record();
    const newer = { ...older, updatedAt: clock.now(), version: older.version + 1 };
    await adapter.putSnapshot(newer);

    expect(await adapter.putSnapshot(older)).toBe(false);
    expect((await adapter.get(id))!.updatedAt).toEqual(newer.updatedAt);
  });

  it("putSnapshot treats the same version arriving again as already held", async () => {
    const row = record();
    await adapter.putSnapshot(row);
    expect(await adapter.putSnapshot(row)).toBe(false);
  });

  it("put still overwrites unconditionally, for the local write paths", async () => {
    const older = record();
    const newer = { ...older, updatedAt: clock.now(), version: older.version + 1 };
    await adapter.put(newer);
    await adapter.put(older);
    expect((await adapter.get(id))!.updatedAt).toEqual(older.updatedAt);
  });

  it("putLabel keeps a newer label rather than writing an older one over it", async () => {
    const older = label();
    const newer = label(true);
    expect(await adapter.putLabel(newer)).toBe(true);

    // A live label arriving after its own retraction must not revive it.
    expect(await adapter.putLabel(older)).toBe(false);
    expect((await adapter.getLabel(id, "photos", "faces", "Alice"))!.deletedAt).not.toBeNull();
  });

  it("putLabel writes a new label and a newer version", async () => {
    expect(await adapter.putLabel(label())).toBe(true);
    const retraction = label(true);
    expect(await adapter.putLabel(retraction)).toBe(true);
    expect((await adapter.getLabel(id, "photos", "faces", "Alice"))!.updatedAt).toEqual(
      retraction.updatedAt,
    );
  });
});
