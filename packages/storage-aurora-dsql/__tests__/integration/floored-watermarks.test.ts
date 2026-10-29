/**
 * Watermark reads relative to a peer's watermarks, against real Postgres.
 *
 * The floored read is a statement of bounded seeks, one per author the floor
 * names and one per gap between them, and it falls back to the grouped read
 * when a gap holds an author. Whether a gap is empty depends on the owner
 * scope reaching the nested selects, and on Postgres ordering `node_id`
 * the way the gaps are bounded, so those are exercised here rather than with a
 * fake client. PGlite stands in for DSQL for the reason
 * `app-syncable-conformance.test.ts` gives.
 *
 * See `readNodeWatermarks` in `@starkeep/storage-adapter`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import {
  createDataRecord,
  createHLCClock,
  serializeHLC,
  type DataRecord,
  type HLCClock,
  type HLCTimestamp,
} from "@starkeep/protocol-primitives";
import type { AppSyncableNamespaceStore } from "@starkeep/shared-space-api";
import { AuroraDsqlDatabaseAdapter } from "../../src/adapter.js";
import { DsqlAppSyncableApplier } from "../../src/app-syncable/apply.js";
import { assertOwnerScoped } from "../../src/owner-scope.js";
import type { DatabaseClient } from "../../src/types.js";
import { createSharedSchema } from "../pg-shared-schema.js";

const A = "user-a";
const B = "user-b";
const APP = "memo";

let pg: PGlite;
let statements: string[];

function client(): DatabaseClient {
  return {
    async query(text, values) {
      assertOwnerScoped(text);
      statements.push(text);
      const result = await pg.query(text, values as unknown[] | undefined);
      return { rows: result.rows as Record<string, unknown>[] };
    },
    async end() {},
  };
}

async function adapterFor(userId: string, types?: string[]): Promise<AuroraDsqlDatabaseAdapter> {
  const adapter = new AuroraDsqlDatabaseAdapter(
    { hostname: "pglite", region: "local" },
    { createClient: async () => client() },
    userId,
    types,
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

let wall = 1_000;
const clocks = new Map<string, HLCClock>();
function clockOf(nodeId: string): HLCClock {
  let clock = clocks.get(nodeId);
  if (!clock) {
    clock = createHLCClock({ nodeId, wallClockFunction: () => wall++ });
    clocks.set(nodeId, clock);
  }
  return clock;
}

let seq = 0;
function record(userId: string, nodeId: string, type = "image/jpeg"): DataRecord {
  const hash = (seq++).toString(16).padStart(64, "0");
  return createDataRecord(
    {
      type,
      originAppId: "photos",
      contentHash: hash,
      objectStorageKey: `shared/${userId}/x/${hash}`,
      mimeType: type,
      sizeBytes: 1,
      originalFilename: `${hash}.bin`,
    },
    clockOf(nodeId),
  );
}

/** Whether the statements since `from` include the grouped read. */
const grouped = (from: number) => statements.slice(from).some((s) => /group by/i.test(s));

beforeEach(async () => {
  pg = new PGlite();
  await pg.waitReady;
  await createSharedSchema(pg);
  await pg.exec(`
    CREATE SCHEMA app_${APP};
    CREATE TABLE app_${APP}.cards (
      user_id text NOT NULL,
      id text NOT NULL,
      front text,
      updated_at text NOT NULL,
      node_id text NOT NULL,
      deleted_at text,
      PRIMARY KEY (user_id, id)
    );
  `);
  statements = [];
});

afterEach(async () => {
  await pg.close();
});

describe("records", () => {
  async function library() {
    const a = await adapterFor(A);
    for (const nodeId of ["node-a", "node-b", "node-c", "node-a", "node-b"]) {
      await a.put(record(A, nodeId));
    }
    return { a, full: await a.getNodeWatermarks() };
  }

  it("matches the grouped read in one statement when the floor is this side's own watermarks", async () => {
    const { a, full } = await library();
    const from = statements.length;
    expect(await a.getNodeWatermarks(full)).toEqual(full);
    expect(statements.length - from).toBe(1);
    expect(grouped(from)).toBe(false);
  });

  it("omits an author below its floor and keeps every other author exact", async () => {
    const { a, full } = await library();
    const ahead = clockOf("node-a").now();
    const floored = await a.getNodeWatermarks({ ...full, "node-a": ahead });
    expect(floored).toEqual({ "node-b": full["node-b"], "node-c": full["node-c"] });
  });

  it("returns an author above its floor at its maximum", async () => {
    const { a, full } = await library();
    const older = { ...full, "node-b": { ...full["node-b"]!, wallTime: 0 } };
    expect(await a.getNodeWatermarks(older)).toEqual(full);
  });

  it("finds an author the floor does not name, by falling back to the grouped read", async () => {
    const { a, full } = await library();
    const from = statements.length;
    const floor = { "node-a": full["node-a"]!, "node-c": full["node-c"]! };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await a.getNodeWatermarks(floor)).toEqual(full);
      expect(warn).toHaveBeenCalledWith(
        "[watermarks] shared.records: floor misses author node-b; reading whole",
      );
    } finally {
      warn.mockRestore();
    }
    expect(grouped(from)).toBe(true);
  });

  it("finds an author sorted before or after every author the floor names", async () => {
    const { a, full } = await library();
    expect(await a.getNodeWatermarks({ "node-b": full["node-b"]! })).toEqual(full);
  });

  it("does not count another user's authors as gaps", async () => {
    const { a, full } = await library();
    const b = await adapterFor(B);
    await b.put(record(B, "node-bb"));
    await b.put(record(B, "node-0"));
    const from = statements.length;
    expect(await a.getNodeWatermarks(full)).toEqual(full);
    expect(grouped(from)).toBe(false);
  });

  it("reads whole on a narrowed adapter, and leaves out types outside its scope", async () => {
    // A type predicate turns DSQL's probes into primary-key scans, so a
    // narrowed adapter ignores the floor. See `probeFloor` in the adapter.
    const { a } = await library();
    await a.put(record(A, "node-bb", "text/plain"));
    const scoped = await adapterFor(A, ["image/jpeg"]);
    const full = await scoped.getNodeWatermarks();
    expect(full["node-bb"]).toBeUndefined();
    const from = statements.length;
    expect(await scoped.getNodeWatermarks(full)).toEqual(full);
    expect(await scoped.getLabelNodeWatermarks(full)).toEqual({});
    expect(statements.slice(from).every((s) => /group by/i.test(s))).toBe(true);
  });

  it("plans the delta scan the same way with or without the floor's omissions", async () => {
    const { a, full } = await library();
    const peer: Record<string, HLCTimestamp> = {
      // Behind on node-a, level on node-b, ahead on node-c, never heard of none.
      "node-a": { ...full["node-a"]!, wallTime: 0 },
      "node-b": full["node-b"]!,
      "node-c": clockOf("node-c").now(),
    };
    const page = await a.querySince(peer, 100);
    expect(page.rows.map((r) => r.updatedAt.nodeId)).toEqual(["node-a", "node-a"]);
    expect(page.hasMore).toBe(false);
  });
});

describe("labels", () => {
  it("reads labels relative to the floor, and finds an author it does not name", async () => {
    const a = await adapterFor(A);
    const target = record(A, "node-a");
    await a.put(target);
    for (const nodeId of ["node-a", "node-b"]) {
      await a.upsertLabels([
        {
          recordId: target.id,
          appId: "photos",
          key: "faces",
          value: nodeId,
          recordType: "image/jpeg",
          hlc: clockOf(nodeId).now(),
        },
      ]);
    }
    const full = await a.getLabelNodeWatermarks();
    expect(Object.keys(full).sort()).toEqual(["node-a", "node-b"]);

    let from = statements.length;
    expect(await a.getLabelNodeWatermarks(full)).toEqual(full);
    expect(grouped(from)).toBe(false);

    from = statements.length;
    expect(await a.getLabelNodeWatermarks({ "node-a": full["node-a"]! })).toEqual(full);
    expect(grouped(from)).toBe(true);
  });
});

describe("app-specific rows", () => {
  const insert = (id: string, nodeId: string) => {
    const timestamp = clockOf(nodeId).now();
    return {
      timestamp,
      appId: APP,
      table: "cards",
      op: "insert" as const,
      row: { id, front: id, updated_at: serializeHLC(timestamp) },
    };
  };

  it("reads an app table relative to the floor", async () => {
    const applier = new DsqlAppSyncableApplier(client(), namespaces, A);
    await applier.apply(insert("c1", "node-a"));
    await applier.apply(insert("c2", "node-b"));
    const full = await applier.getNodeWatermarks(APP, "cards");

    const from = statements.length;
    expect(await applier.getNodeWatermarks(APP, "cards", full)).toEqual(full);
    expect(grouped(from)).toBe(false);

    const ahead = clockOf("node-b").now();
    expect(await applier.getNodeWatermarks(APP, "cards", { ...full, "node-b": ahead })).toEqual({
      "node-a": full["node-a"],
    });
  });

  it("reads a missing table as holding nothing, with or without a floor", async () => {
    const applier = new DsqlAppSyncableApplier(client(), namespaces, A);
    const floor = { "node-a": clockOf("node-a").now() };
    expect(await applier.getNodeWatermarks(APP, "no_such_table", floor)).toEqual({});
  });
});
