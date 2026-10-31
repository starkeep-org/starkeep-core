/**
 * Two users, one database: neither reads, lists, counts, labels, describes,
 * overwrites or deletes the other's rows.
 *
 * Every statement the cloud runs against its owned tables goes through an
 * adapter or an applier scoped to one user (see `owner-scope.ts`), so this
 * exercises the cut where it is made, against real Postgres. PGlite stands in
 * for DSQL for the reason `app-syncable-conformance.test.ts` gives.
 *
 * The tables come from `pg-shared-schema.ts`, written the way the installer
 * creates them: the owner first, and first in every primary key.
 *
 * See `~/projects/starkeep/plan-multi-user-roles-2026-10-16.md`, phase 4
 * "Checks".
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { createDataRecord, createHLCClock, type DataRecord } from "@starkeep/protocol-primitives";
import type { AppSyncableNamespaceStore } from "@starkeep/shared-space-api";
import { AuroraDsqlDatabaseAdapter } from "../../src/adapter.js";
import { DsqlAppSyncableApplier } from "../../src/app-syncable/apply.js";
import { createDsqlByteCoverageStore } from "../../src/byte-coverage.js";
import { assertOwnerScoped } from "../../src/owner-scope.js";
import type { DatabaseClient } from "../../src/types.js";
import { createAppNodeWatermarks, createSharedSchema } from "../pg-shared-schema.js";
import { guardNodeWatermarks } from "../../src/node-watermarks.js";
import { guardSingleFlight } from "../../src/single-flight.js";

const A = "user-a";
const B = "user-b";
const APP = "memo";
const SCHEMA = "app_memo";

let pg: PGlite;

/** The client the adapters talk to, with the broker's tripwires on every statement. */
function client(): DatabaseClient {
  return guardSingleFlight(
    guardNodeWatermarks({
      async query(text, values) {
        assertOwnerScoped(text);
        const result = await pg.query(text, values as unknown[] | undefined);
        return { rows: result.rows as Record<string, unknown>[] };
      },
      async end() {},
    }),
    { onOverlap: "throw" },
  );
}

async function adapterFor(userId: string): Promise<AuroraDsqlDatabaseAdapter> {
  const adapter = new AuroraDsqlDatabaseAdapter(
    { hostname: "pglite", region: "local" },
    { createClient: async () => client() },
    userId,
  );
  await adapter.init();
  return adapter;
}

const namespaces: AppSyncableNamespaceStore = {
  get: (appId) =>
    appId === APP
      ? {
          appId: APP,
          tables: [{ name: "cards", pkColumns: ["id"] }],
          filesEnabled: false,
          tableNames: ["cards"],
        }
      : null,
  list: () => [],
} as never;

beforeEach(async () => {
  pg = new PGlite();
  await pg.waitReady;
  await createSharedSchema(pg);
  await pg.exec(`
    CREATE SCHEMA ${SCHEMA};
    CREATE TABLE ${SCHEMA}.cards (
      user_id text NOT NULL,
      id text NOT NULL,
      front text,
      updated_at text NOT NULL,
      node_id text NOT NULL,
      deleted_at text,
      PRIMARY KEY (user_id, id)
    );
    CREATE TABLE ${SCHEMA}._starkeep_byte_coverage (
      user_id text NOT NULL,
      node_id text NOT NULL,
      hlc text NOT NULL,
      PRIMARY KEY (user_id, node_id)
    );
  `);
  await createAppNodeWatermarks(pg, SCHEMA);
});

afterEach(async () => {
  await pg.close();
});

const clock = createHLCClock({ nodeId: "node-a" });

/** A record each user can hold under one id: ids are content-addressed. */
function photo(userId: string, name = "cat.jpg"): DataRecord {
  const hash = "a".repeat(64);
  return createDataRecord(
    {
      type: "image/jpeg",
      originAppId: "photos",
      contentHash: hash,
      objectStorageKey: `shared/${userId}/image/aa/${hash}`,
      mimeType: "image/jpeg",
      sizeBytes: 10,
      originalFilename: name,
    },
    clock,
  );
}

describe("shared records", () => {
  it("keeps two users' records apart, even under one id", async () => {
    const [a, b] = [await adapterFor(A), await adapterFor(B)];
    const ra = photo(A);
    const rb = { ...photo(B), id: ra.id };
    await a.put(ra);
    await b.put(rb);

    expect((await a.get(ra.id))!.objectStorageKey).toBe(ra.objectStorageKey);
    expect((await b.get(ra.id))!.objectStorageKey).toBe(rb.objectStorageKey);
    expect((await a.query({})).records).toHaveLength(1);
    expect(await b.countRecords({})).toBe(1);
    expect(await a.countRecordsByType({})).toEqual([
      expect.objectContaining({ type: "image/jpeg", count: 1 }),
    ]);
  });

  it("lists, counts and finds nothing of the other user's", async () => {
    const [a, b] = [await adapterFor(A), await adapterFor(B)];
    const ra = photo(A);
    await a.put(ra);

    expect(await b.get(ra.id)).toBeNull();
    expect((await b.query({})).records).toEqual([]);
    expect(await b.countRecords({})).toBe(0);
    expect(await b.countRecordsByType({})).toEqual([]);
    expect(await b.getNodeWatermarks()).toEqual({});
    expect((await b.querySince({}, 100)).rows).toEqual([]);
    expect(await b.bucketDigest()).toEqual([]);
  });

  it("cannot delete or overwrite the other user's record", async () => {
    const [a, b] = [await adapterFor(A), await adapterFor(B)];
    const ra = photo(A);
    await a.put(ra);

    await b.delete(ra.id, clock.now());
    expect((await a.get(ra.id))!.deletedAt).toBeNull();

    // B's write under A's id lands in B's library, and A's row is unchanged.
    await b.put({ ...ra, originalFilename: "dog.jpg" });
    expect((await a.get(ra.id))!.originalFilename).toBe("cat.jpg");
    expect((await b.get(ra.id))!.originalFilename).toBe("dog.jpg");
  });

  it("never returns the owner column", async () => {
    const a = await adapterFor(A);
    await a.put(photo(A));
    await a.putMetadata("image/jpeg", { recordId: photo(A).id, width: 4 });
    expect(Object.keys((await a.getMetadata("image/jpeg", photo(A).id))!)).not.toContain("user_id");
  });
});

describe("labels, metadata and availability", () => {
  it("keeps labels apart", async () => {
    const [a, b] = [await adapterFor(A), await adapterFor(B)];
    const ra = photo(A);
    await a.put(ra);
    await a.upsertLabels([
      {
        recordId: ra.id,
        appId: "photos",
        key: "faces",
        value: "Alice",
        recordType: "image/jpeg",
        hlc: clock.now(),
      },
    ]);

    expect((await a.getLabelsByRecordIds([ra.id])).get(ra.id)).toHaveLength(1);
    expect((await b.getLabelsByRecordIds([ra.id])).size).toBe(0);
    expect((await b.queryLabels({})).labels).toEqual([]);
    expect(await b.getLabel(ra.id, "photos", "faces", "Alice")).toBeNull();
    expect(await b.getLabelNodeWatermarks()).toEqual({});

    await b.tombstoneLabelsForRecord(ra.id, clock.now());
    expect((await a.getLabelsByRecordIds([ra.id])).get(ra.id)![0]!.deletedAt).toBeNull();
  });

  it("keeps metadata apart", async () => {
    const [a, b] = [await adapterFor(A), await adapterFor(B)];
    const ra = photo(A);
    await a.putMetadata("image/jpeg", { recordId: ra.id, width: 4032 });

    expect(await b.getMetadata("image/jpeg", ra.id)).toBeNull();
    expect((await b.getMetadataByIds("image/jpeg", [ra.id])).size).toBe(0);
    await b.putMetadata("image/jpeg", { recordId: ra.id, width: 1 });
    await b.deleteMetadata("image/jpeg", ra.id);
    expect((await a.getMetadata("image/jpeg", ra.id))!["width"]).toBe(4032);
  });

  it("keeps availability apart", async () => {
    const [a, b] = [await adapterFor(A), await adapterFor(B)];
    const key = photo(A).objectStorageKey!;
    await a.putAvailability({
      objectStorageKey: key,
      state: "restoring",
      tier: "DEEP_ARCHIVE",
      expectedLatencyHours: 48,
      readyAtMs: null,
      restoredUntilMs: null,
      observedAtMs: 1,
    });

    expect((await a.getAvailability([key])).size).toBe(1);
    expect((await b.getAvailability([key])).size).toBe(0);
    expect(await b.countRestoringObjects()).toEqual({ objectCount: 0, bytes: 0 });
  });
});

describe("app-specific rows", () => {
  const hlc = (n: number, node = "node-a") => `${n.toString(16).padStart(12, "0")}:0000:${node}`;
  const insert = (front: string, n: number) => ({
    timestamp: { wallTime: n, counter: 0, nodeId: "node-a" },
    appId: APP,
    table: "cards",
    op: "insert" as const,
    row: { id: "c1", front, updated_at: hlc(n) },
  });

  it("keeps rows with one fixed id apart, in scans, digests and queries", async () => {
    const a = new DsqlAppSyncableApplier(client(), namespaces, A);
    const b = new DsqlAppSyncableApplier(client(), namespaces, B);
    await a.apply(insert("from A", 1));
    await b.apply(insert("from B", 2));

    const scanA = await a.scanSince(APP, "cards", {}, 100);
    expect(scanA.rows.map((r) => r.row?.["front"])).toEqual(["from A"]);
    expect(scanA.rows[0]!.row).not.toHaveProperty("user_id");
    expect((await b.scanSince(APP, "cards", {}, 100)).rows.map((r) => r.row?.["front"])).toEqual([
      "from B",
    ]);
    expect(Object.keys(await a.getNodeWatermarks(APP, "cards"))).toEqual(["node-a"]);

    const query = await b.runQuery(APP, "cards", {
      mode: "rows",
      table: "cards",
      select: null,
      where: [],
      order: [{ column: "id", direction: "asc", nulls: "last" }],
      limit: 100,
      pageToken: null,
      include: [],
    } as never);
    if (query.mode !== "rows") throw new Error("expected rows");
    expect(query.rows).toEqual([expect.objectContaining({ front: "from B" })]);
    expect(query.rows[0]).not.toHaveProperty("user_id");
  });

  it("cannot retract or overwrite the other user's row", async () => {
    const a = new DsqlAppSyncableApplier(client(), namespaces, A);
    const b = new DsqlAppSyncableApplier(client(), namespaces, B);
    await a.apply(insert("from A", 1));

    await b.apply({
      timestamp: { wallTime: 9, counter: 0, nodeId: "node-b" },
      appId: APP,
      table: "cards",
      op: "update",
      row: { front: "rewritten", updated_at: hlc(9, "node-b") },
      where: { id: "c1", user_id: A },
    });
    await b.apply({
      timestamp: { wallTime: 9, counter: 0, nodeId: "node-b" },
      appId: APP,
      table: "cards",
      op: "delete",
      where: { id: "c1" },
    });

    const scan = await a.scanSince(APP, "cards", {}, 100);
    expect(scan.rows).toEqual([
      expect.objectContaining({ op: "insert", row: expect.objectContaining({ front: "from A" }) }),
    ]);
  });

  it("keeps each user's bytes watermark apart", async () => {
    const at = { wallTime: 5, counter: 0, nodeId: "node-a" };
    await createDsqlByteCoverageStore(client(), APP, A).save({ "node-a": at });
    expect(await createDsqlByteCoverageStore(client(), APP, A).load()).toEqual({ "node-a": at });
    expect(await createDsqlByteCoverageStore(client(), APP, B).load()).toEqual({});
  });
});
