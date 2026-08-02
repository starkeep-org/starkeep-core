/**
 * The real `SqliteDatabaseAdapter`, driven through the op-sqlite driver.
 *
 * This is the test item 10 existed for. The driver satisfying `RawDatabase` is
 * necessary and proves little on its own; what matters is whether the ~1000
 * lines of adapter above it — schema bootstrap, records, labels, metadata,
 * watermarks, transactions — work unchanged against a driver that is not
 * `node:sqlite`. If they do, the phone reuses the adapter rather than growing a
 * second one that will drift.
 *
 * The connection underneath is still real SQLite, because the question here is
 * "does the seam hold", not "does SQLite work". Whether op-sqlite honours its
 * own type signatures is a device question and is recorded as a gap.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { SqliteDatabaseAdapter } from "@starkeep/storage-sqlite";
import { createOpSqliteDriver, type OpSqliteConnection } from "../src/db/op-sqlite-driver";
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

let adapter: SqliteDatabaseAdapter;

/** HLC timestamps are structured, not serialized strings, at this boundary. */
const hlc = (counter: number, nodeId = "node-a") => ({
  wallTime: Date.UTC(2026, 0, 1),
  counter,
  nodeId,
});

/**
 * Distinct bytes per record by default.
 *
 * `shared_records` carries a UNIQUE constraint on (original_filename,
 * content_hash) — the record-level dedup from item 20 — so a fixture that
 * reused one hash across records would fail on the constraint rather than on
 * anything this file is testing.
 */
let seq = 0;
const record = (over: Partial<DataRecord> = {}): DataRecord => {
  seq += 1;
  const hash = String(seq).padStart(64, "0");
  return {
    id: `rec-${seq}`,
    type: "image/jpeg",
    createdAt: hlc(1),
    updatedAt: hlc(1),
    deletedAt: null,
    version: 1,
    contentHash: hash,
    objectStorageKey: `shared/image/${hash.slice(0, 2)}/${hash}`,
    mimeType: "image/jpeg",
    sizeBytes: 1234,
    originAppId: "photos",
    parentId: null,
    originalFilename: `photo-${seq}.jpg`,
    ...over,
  } as DataRecord;
};

beforeEach(async () => {
  adapter = new SqliteDatabaseAdapter({
    path: "local.sqlite",
    driver: createOpSqliteDriver(fakeOpSqlite()),
  });
  await adapter.init();
});

afterEach(async () => {
  await adapter.close();
});

describe("the adapter runs unchanged on a second driver", () => {
  // Schema bootstrap is the first thing that would break: it is a run of DDL
  // statements through `exec`, and op-sqlite runs only the first statement of a
  // multi-statement string on native.
  it("bootstraps its schema", async () => {
    expect(await adapter.healthCheck()).toBe(true);
  });

  it("round-trips a record", async () => {
    const written = record();
    await adapter.put(written);
    const read = await adapter.get(written.id as never);
    expect(read).toMatchObject({ id: written.id, contentHash: written.contentHash, sizeBytes: 1234 });
  });

  it("returns null for a record that is not there", async () => {
    expect(await adapter.get("nope" as never)).toBeNull();
  });

  it("queries by type", async () => {
    const image = record();
    await adapter.put(image);
    await adapter.put(record({ type: "video/mp4" }));
    const images = await adapter.query({ type: "image/jpeg" });
    expect(images.records.map((r) => r.id)).toEqual([image.id]);
  });

  // Tombstones rather than removal, because a sync delta has to be able to see
  // that a record was deleted.
  it("soft-deletes, leaving the row visible to sync", async () => {
    const written = record();
    await adapter.put(written);
    await adapter.delete(written.id as never, hlc(2) as never);
    const read = await adapter.get(written.id as never);
    expect(read?.deletedAt).not.toBeNull();
  });

  it("reports per-node watermarks", async () => {
    await adapter.put(record());
    const watermarks = await adapter.getNodeWatermarks();
    expect(Object.keys(watermarks).length).toBeGreaterThan(0);
  });

  it("writes and reads per-type metadata", async () => {
    const written = record();
    await adapter.put(written);
    await adapter.putMetadata("image", { recordId: written.id, width: 4032, height: 3024 } as never);
    const meta = await adapter.getMetadata("image", written.id as never);
    expect(meta).toMatchObject({ width: 4032, height: 3024 });
  });

  it("batches writes", async () => {
    const a = record();
    const b = record();
    await adapter.batch([
      { type: "put", record: a },
      { type: "put", record: b },
    ] as never);
    expect(await adapter.get(a.id as never)).not.toBeNull();
    expect(await adapter.get(b.id as never)).not.toBeNull();
  });

  // The seam's whole purpose: sibling subsystems create their own tables in the
  // same file through this handle. If it did not work, the sync engine, the
  // resident set and the state store would all need phone-specific versions.
  it("hands out a usable raw connection for sibling subsystems", () => {
    const raw = adapter.getRawDatabase();
    raw.exec("CREATE TABLE side_table (k TEXT PRIMARY KEY, v INTEGER)");
    raw.prepare("INSERT INTO side_table VALUES (?, ?)").run("a", 1);
    const row = raw.prepare("SELECT v FROM side_table WHERE k = ?").get("a") as { v: number };
    expect(row.v).toBe(1);
  });
});
