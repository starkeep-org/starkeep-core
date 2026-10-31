/**
 * The node watermark tables against real SQL: every write raises its entry in
 * its own transaction, coverage reads come from the entries, and the guard
 * refuses anything else. See `src/node-watermarks.ts`.
 *
 * Every client here runs under the broker's tripwires, the owner-scope
 * assertion, `guardNodeWatermarks` and `guardSingleFlight`, so a write path
 * that skipped its raise fails here the way it would fail in the cloud. The
 * single-flight guard throws here, where the broker only warns. PGlite stands in for DSQL for
 * the reason `app-syncable-conformance.test.ts` gives.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import {
  createDataRecord,
  createHLCClock,
  serializeHLC,
  type DataRecord,
  type HLCTimestamp,
} from "@starkeep/protocol-primitives";
import type { AppSyncableNamespaceStore, AppSyncableRowEntry } from "@starkeep/shared-space-api";
import { MockObjectStorageAdapter } from "@starkeep/storage-adapter";
import {
  createInProcessSyncTransport,
  type ByteCoverageStore,
  type SyncExchangeRequest,
  type Watermarks,
} from "@starkeep/sync-engine";
import { AuroraDsqlDatabaseAdapter } from "../../src/adapter.js";
import { DsqlAppSyncableApplier } from "../../src/app-syncable/apply.js";
import { createDsqlByteCoverageStore } from "../../src/byte-coverage.js";
import {
  LABEL_WATERMARKS_TABLE,
  RECORD_WATERMARKS_TABLE,
  RECORDS_SOURCE,
  appSource,
  buildWatermarkRaise,
  guardNodeWatermarks,
} from "../../src/node-watermarks.js";
import { guardSingleFlight } from "../../src/single-flight.js";
import { assertOwnerScoped } from "../../src/owner-scope.js";
import { ownerScopedCompiler } from "../../src/query-builder.js";
import type { DatabaseClient } from "../../src/types.js";
import { createAppNodeWatermarks, createSharedSchema } from "../pg-shared-schema.js";

const A = "user-a";
const B = "user-b";
const MEMO = "memo";
const DRIVE = "starkeep-drive";
const APP_WATERMARKS = "app_memo._starkeep_node_watermarks";

let pg: PGlite;
/** Every statement any client sent, in order. */
let statements: string[];
let memoInstalled: boolean;

/** A client under the broker's tripwires, as `ownerGuardedFactory` builds one. */
function client(): DatabaseClient {
  return guardSingleFlight(
    guardNodeWatermarks({
      async query(text, values) {
        statements.push(text);
        assertOwnerScoped(text);
        const result = await pg.query(text, values as unknown[] | undefined);
        return { rows: result.rows as Record<string, unknown>[] };
      },
      async end() {},
    }),
    { onOverlap: "throw" },
  );
}

async function adapterFor(
  userId: string,
  readableTypes?: readonly string[],
): Promise<AuroraDsqlDatabaseAdapter> {
  const adapter = new AuroraDsqlDatabaseAdapter(
    { hostname: "pglite", region: "local" },
    { createClient: async () => client() },
    userId,
    readableTypes,
  );
  await adapter.init();
  return adapter;
}

const memoNamespace = {
  appId: MEMO,
  tables: [{ name: "cards", pkColumns: ["id"] }],
  filesEnabled: false,
  tableNames: ["cards"],
};

const namespaces: AppSyncableNamespaceStore = {
  get: (appId) => (appId === MEMO && memoInstalled ? memoNamespace : null),
  list: () => (memoInstalled ? [memoNamespace] : []),
} as never;

function applierFor(userId: string): DsqlAppSyncableApplier {
  return new DsqlAppSyncableApplier(client(), namespaces, userId);
}

async function installMemo(): Promise<void> {
  await pg.exec(`
    CREATE SCHEMA app_memo;
    CREATE TABLE app_memo.cards (
      user_id text NOT NULL,
      id text NOT NULL,
      front text,
      updated_at text NOT NULL,
      node_id text NOT NULL,
      deleted_at text,
      PRIMARY KEY (user_id, id)
    );
  `);
  await createAppNodeWatermarks(pg, "app_memo");
  memoInstalled = true;
}

async function uninstallMemo(): Promise<void> {
  await pg.exec(`DROP SCHEMA app_memo CASCADE`);
  memoInstalled = false;
}

beforeEach(async () => {
  pg = new PGlite();
  await pg.waitReady;
  statements = [];
  await createSharedSchema(pg);
  await pg.exec(`
    CREATE SCHEMA app_starkeep_drive;
    CREATE TABLE app_starkeep_drive._starkeep_byte_coverage (
      user_id text NOT NULL,
      node_id text NOT NULL,
      hlc text NOT NULL,
      PRIMARY KEY (user_id, node_id)
    );
  `);
  await createAppNodeWatermarks(pg, "app_starkeep_drive");
  await installMemo();
});

afterEach(async () => {
  await pg.close();
});

/** A stamp by `nodeId` at wall time `wall`. */
function at(nodeId: string, wall: number): HLCTimestamp {
  return { wallTime: Date.UTC(2026, 9, 30) + wall, counter: 0, nodeId };
}

let fileSeq = 0;

/** A metadata-only record stamped `hlc`, so no test here needs a file. */
function record(hlc: HLCTimestamp, type = "image/jpeg"): DataRecord {
  const made = createDataRecord(
    {
      type,
      originAppId: "photos",
      contentHash: (fileSeq++).toString(16).padStart(64, "0"),
      objectStorageKey: "",
      mimeType: type,
      sizeBytes: 0,
    },
    { now: () => hlc } as never,
  );
  return { ...made, createdAt: hlc, updatedAt: hlc };
}

/** `user`'s entries in `table`, as `{ "<key>/<node>": stamp }`. */
async function entries(table: string, user = A): Promise<Record<string, string>> {
  const key =
    table === RECORD_WATERMARKS_TABLE
      ? "type"
      : table === LABEL_WATERMARKS_TABLE
        ? "record_type"
        : "table_name";
  const { rows } = await pg.query<{ k: string; node_id: string; updated_at: string }>(
    `SELECT ${key} AS k, node_id, updated_at FROM ${table} WHERE user_id = $1`,
    [user],
  );
  return Object.fromEntries(rows.map((r) => [`${r.k}/${r.node_id}`, r.updated_at]));
}

function cardEntry(
  op: AppSyncableRowEntry["op"],
  id: string,
  hlc: HLCTimestamp,
  front = "q",
): AppSyncableRowEntry {
  const stamp = serializeHLC(hlc);
  return op === "delete"
    ? { timestamp: hlc, appId: MEMO, table: "cards", op, where: { id }, row: { updated_at: stamp } }
    : op === "update"
      ? {
          timestamp: hlc,
          appId: MEMO,
          table: "cards",
          op,
          where: { id },
          row: { front, updated_at: stamp },
        }
      : { timestamp: hlc, appId: MEMO, table: "cards", op, row: { id, front, updated_at: stamp } };
}

const s = serializeHLC;

describe("every write path raises its entry", () => {
  it("records: put, delete and batch", async () => {
    const a = await adapterFor(A);
    const r = record(at("put", 1));
    await a.put(r);
    await a.delete(r.id, at("del", 2));
    // Two records: a row written twice in one transaction lands only its
    // last stamp, which understates the first, safely.
    const pdf = record(at("batch-1", 3), "document/pdf");
    const seeded = record(at("seed", 0), "document/pdf");
    await a.put(seeded);
    await a.batch([
      { type: "put", record: pdf },
      { type: "delete", id: seeded.id, hlc: at("batch-2", 4) },
    ]);
    expect(await entries(RECORD_WATERMARKS_TABLE)).toEqual({
      "image/jpeg/put": s(at("put", 1)),
      "image/jpeg/del": s(at("del", 2)),
      "document/pdf/seed": s(at("seed", 0)),
      "document/pdf/batch-1": s(at("batch-1", 3)),
      "document/pdf/batch-2": s(at("batch-2", 4)),
    });
  });

  it("labels: putLabel, upsertLabels, retractLabels, replaceLabelValues, and the record cascade", async () => {
    const a = await adapterFor(A);
    const r = record(at("rec", 1));
    await a.put(r);
    const base = { recordId: r.id, appId: "photos", recordType: "image/jpeg" };
    await a.putLabel({
      ...base,
      key: "snap",
      value: "",
      createdAt: at("snap", 2),
      updatedAt: at("snap", 2),
      nodeId: "snap",
      deletedAt: null,
    });
    await a.upsertLabels([
      { ...base, key: "faces", value: "Ann", hlc: at("up-1", 3) },
      { ...base, key: "faces", value: "Bo", hlc: at("up-2", 4) },
    ]);
    await a.retractLabels([{ ...base, key: "faces", value: "Ann", hlc: at("retract", 5) }]);
    await a.replaceLabelValues([{ ...base, key: "album", values: ["x"], hlc: at("replace", 6) }]);
    await a.tombstoneLabelsForRecord(r.id, at("tomb", 7));
    await a.restoreLabelsForRecord(r.id, at("tomb", 7), at("restore", 8));
    expect(await entries(LABEL_WATERMARKS_TABLE)).toEqual({
      "image/jpeg/snap": s(at("snap", 2)),
      "image/jpeg/up-1": s(at("up-1", 3)),
      "image/jpeg/up-2": s(at("up-2", 4)),
      "image/jpeg/retract": s(at("retract", 5)),
      "image/jpeg/replace": s(at("replace", 6)),
      "image/jpeg/tomb": s(at("tomb", 7)),
      "image/jpeg/restore": s(at("restore", 8)),
    });
  });

  it("app tables: apply with insert, update and delete", async () => {
    const applier = applierFor(A);
    await applier.apply(cardEntry("insert", "c1", at("ins", 1)));
    await applier.apply(cardEntry("update", "c1", at("upd", 2), "q2"));
    await applier.apply(cardEntry("delete", "c1", at("del", 3)));
    expect(await entries(APP_WATERMARKS)).toEqual({
      "cards/ins": s(at("ins", 1)),
      "cards/upd": s(at("upd", 2)),
      "cards/del": s(at("del", 3)),
    });
  });
});

describe("what an entry records", () => {
  it("keeps an author whose rows were all superseded", async () => {
    const a = await adapterFor(A);
    const r = record(at("old", 1));
    await a.put(r);
    await a.put({ ...r, updatedAt: at("new", 2) });
    // The live rows hold only `new`; coverage still says `old` reached us.
    expect(await a.getNodeWatermarks()).toEqual({ old: at("old", 1), new: at("new", 2) });
  });

  it("records nothing for an applier write that loses last-writer-wins", async () => {
    const applier = applierFor(A);
    await applier.apply(cardEntry("insert", "c1", at("winner", 5)));
    await applier.apply(cardEntry("insert", "c1", at("loser", 1)));
    await applier.apply(cardEntry("update", "c1", at("loser-2", 2)));
    expect(await entries(APP_WATERMARKS)).toEqual({ "cards/winner": s(at("winner", 5)) });
  });

  it("takes its value from a row: a stamp no row carries, or another user's, records nothing", async () => {
    const b = await adapterFor(B);
    await b.put(record(at("b-node", 3)));
    const c = client();
    const raise = (stamp: string) =>
      buildWatermarkRaise(ownerScopedCompiler(A), RECORDS_SOURCE, "b-node", [stamp]);
    await c.query("BEGIN");
    for (const q of [raise(s(at("b-node", 9))), raise(s(at("b-node", 3)))]) {
      await c.query(q.sql, [...q.parameters]);
    }
    await c.query("COMMIT");
    expect(await entries(RECORD_WATERMARKS_TABLE, A)).toEqual({});
    expect(await entries(RECORD_WATERMARKS_TABLE, B)).toEqual({
      "image/jpeg/b-node": s(at("b-node", 3)),
    });
  });

  it("after random writes, equals the highest stamp that ever landed per key", async () => {
    // A small deterministic PRNG, so a failure reproduces.
    let seed = 42;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    const a = await adapterFor(A);
    const applier = applierFor(A);
    const authors = ["n1", "n2", "n3"];
    const recs = [record(at("n1", 0)), record(at("n1", 0), "document/pdf")];
    const live = new Map<string, HLCTimestamp>(); // record id → stamp
    const cards = new Map<string, string>(); // card id → stamp
    const recordModel: Record<string, string> = {};
    const cardModel: Record<string, string> = {};
    const raiseModel = (model: Record<string, string>, key: string, stamp: string) => {
      if (!model[key] || stamp > model[key]) model[key] = stamp;
    };

    for (let i = 0; i < 60; i++) {
      const hlc = at(authors[rand(3)]!, rand(40));
      const op = rand(3);
      if (op === 0) {
        const r = recs[rand(2)]!;
        await a.put({ ...r, updatedAt: hlc });
        live.set(r.id, hlc);
        raiseModel(recordModel, `${r.type}/${hlc.nodeId}`, s(hlc));
      } else if (op === 1) {
        const r = recs[rand(2)]!;
        await a.delete(r.id, hlc);
        // A tombstone is an update: it lands only on a row that exists.
        if (live.has(r.id)) raiseModel(recordModel, `${r.type}/${hlc.nodeId}`, s(hlc));
      } else {
        const id = `c${rand(2)}`;
        await applier.apply(cardEntry("insert", id, hlc));
        // The applier's upsert lands only above the row it would replace.
        const held = cards.get(id);
        if (held === undefined || s(hlc) > held) {
          cards.set(id, s(hlc));
          raiseModel(cardModel, `cards/${hlc.nodeId}`, s(hlc));
        }
      }
    }

    expect(await entries(RECORD_WATERMARKS_TABLE)).toEqual(recordModel);
    expect(await entries(APP_WATERMARKS)).toEqual(cardModel);
    // And never below what the rows would say.
    const { rows } = await pg.query<{ node_id: string; m: string }>(
      `SELECT node_id, max(updated_at) AS m FROM shared.records WHERE user_id = $1 GROUP BY node_id`,
      [A],
    );
    const coverage = await a.getNodeWatermarks();
    for (const row of rows) expect(s(coverage[row.node_id]!) >= row.m).toBe(true);
  });
});

describe("reads", () => {
  it("narrow to a type scope's types, for records and labels, and never show another user's", async () => {
    const a = await adapterFor(A);
    const jpeg = record(at("jpeg-author", 1));
    const pdf = record(at("pdf-author", 2), "document/pdf");
    await a.put(jpeg);
    await a.put(pdf);
    await a.upsertLabels([
      {
        recordId: jpeg.id,
        appId: "photos",
        key: "k",
        value: "",
        recordType: "image/jpeg",
        hlc: at("jl", 3),
      },
      {
        recordId: pdf.id,
        appId: "photos",
        key: "k",
        value: "",
        recordType: "document/pdf",
        hlc: at("pl", 4),
      },
    ]);
    const b = await adapterFor(B);
    await b.put(record(at("b-author", 5)));

    const phone = await adapterFor(A, ["image/jpeg"]);
    expect(await phone.getNodeWatermarks()).toEqual({ "jpeg-author": at("jpeg-author", 1) });
    expect(await phone.getLabelNodeWatermarks()).toEqual({ jl: at("jl", 3) });
    const desktop = await adapterFor(A);
    expect(Object.keys(await desktop.getNodeWatermarks()).sort()).toEqual([
      "jpeg-author",
      "pdf-author",
    ]);
  });

  it("throw for an installed app without its watermark table, and answer {} for an uninstalled one", async () => {
    await pg.exec(`DROP TABLE ${APP_WATERMARKS}`);
    await expect(applierFor(A).getNodeWatermarks(MEMO, "cards")).rejects.toThrow(/reinstall/);
    await uninstallMemo();
    expect(await applierFor(A).getNodeWatermarks(MEMO, "cards")).toEqual({});
  });

  it("read each table once until a write through the same instance", async () => {
    const a = await adapterFor(A);
    await a.put(record(at("first", 1)));
    const reads = () =>
      statements.filter((t) => /^select .* from "shared"\."node_watermarks_records"/.test(t))
        .length;
    const before = reads();
    await a.getNodeWatermarks();
    await a.querySince({}, 10);
    await a.getNodeWatermarks();
    expect(reads() - before).toBe(1);
    await a.put(record(at("second", 2)));
    expect(Object.keys(await a.getNodeWatermarks()).sort()).toEqual(["first", "second"]);
    expect(reads() - before).toBe(2);

    const applier = applierFor(A);
    const appReads = () =>
      statements.filter((t) => /^select .* from "app_memo"\."_starkeep_node_watermarks"/.test(t))
        .length;
    const appBefore = appReads();
    await applier.getNodeWatermarks(MEMO, "cards");
    await applier.scanSince(MEMO, "cards", {}, 10);
    expect(appReads() - appBefore).toBe(1);
    await applier.apply(cardEntry("insert", "c1", at("card", 3)));
    expect(await applier.getNodeWatermarks(MEMO, "cards")).toEqual({ card: at("card", 3) });
    expect(appReads() - appBefore).toBe(2);
  });
});

describe("the guard", () => {
  const qb = ownerScopedCompiler(A);
  const put = () => {
    const r = record(at("g", 1));
    return qb
      .insertInto("shared.records")
      .values({
        id: r.id,
        type: r.type,
        created_at: s(r.createdAt),
        updated_at: s(r.updatedAt),
        node_id: "g",
        content_hash: r.contentHash,
        object_storage_key: "",
        size_bytes: 0,
        origin_app_id: "photos",
      })
      .compile();
  };

  it("refuses a synced write outside a transaction", async () => {
    const q = put();
    await expect(client().query(q.sql, [...q.parameters])).rejects.toThrow(/outside a transaction/);
    expect((await pg.query("SELECT 1 FROM shared.records")).rows).toEqual([]);
  });

  it("refuses a COMMIT that skipped the raise, and rolls the write back", async () => {
    const c = client();
    const q = put();
    await c.query("BEGIN");
    await c.query(q.sql, [...q.parameters]);
    await expect(c.query("COMMIT")).rejects.toThrow(/without raising/);
    expect((await pg.query("SELECT 1 FROM shared.records")).rows).toEqual([]);
  });

  it("refuses every non-canonical write to the three tables", async () => {
    const stamp = s(at("forged", 99));
    const forged = [
      qb
        .insertInto(RECORD_WATERMARKS_TABLE)
        .values({ type: "image/jpeg", node_id: "forged", updated_at: stamp })
        .compile(),
      qb.updateTable(LABEL_WATERMARKS_TABLE).set({ updated_at: stamp }).compile(),
      qb.deleteFrom(APP_WATERMARKS).compile(),
      // The canonical raise for one table, pointed at another's entries.
      {
        ...buildWatermarkRaise(qb, appSource(MEMO, "cards"), "n", [stamp]),
        sql: buildWatermarkRaise(qb, appSource(MEMO, "cards"), "n", [stamp]).sql.replace(
          '"app_memo"."cards"',
          '"app_memo"."_starkeep_byte_coverage"',
        ),
      },
    ];
    const c = client();
    await c.query("BEGIN");
    for (const q of forged) {
      await expect(c.query(q.sql, [...q.parameters])).rejects.toThrow(/refused/);
    }
    await c.query("ROLLBACK");
  });

  it("refuses savepoints, which could undo a counted raise", async () => {
    const c = client();
    await c.query("BEGIN");
    await expect(c.query("SAVEPOINT s")).rejects.toThrow(/savepoint/);
    await c.query("ROLLBACK");
  });
});

describe("sync exchanges over the entries", () => {
  /** A bytes-watermark store that counts its saves. */
  function countingStore(userId: string): ByteCoverageStore & { saves: number } {
    const inner = createDsqlByteCoverageStore(client(), DRIVE, userId);
    const store = {
      saves: 0,
      load: () => inner.load(),
      async save(w: Watermarks) {
        store.saves++;
        await inner.save(w);
      },
    };
    return store;
  }

  /** One Drive-channel exchange on fresh instances, as the broker builds them per request. */
  async function driveExchange(request: SyncExchangeRequest, store = countingStore(A)) {
    const transport = createInProcessSyncTransport({
      databaseAdapter: await adapterFor(A),
      clock: createHLCClock({ nodeId: "cloud-1" }),
      objectStorage: new MockObjectStorageAdapter(),
      byteCoverage: store,
    });
    return { response: await transport.exchange(request), store };
  }

  async function memoExchange(request: SyncExchangeRequest) {
    const transport = createInProcessSyncTransport({
      databaseAdapter: await adapterFor(A),
      clock: createHLCClock({ nodeId: "cloud-1" }),
      objectStorage: new MockObjectStorageAdapter(),
      syncSharedRecords: false,
      appSyncableSource: { namespaces, applier: applierFor(A) },
    });
    return transport.exchange(request);
  }

  it("reports, after supersession, coverage equal to the requester's on an idle tick, and saves no bytes watermark", async () => {
    const r = record(at("old", 1));
    const superseding = { ...r, updatedAt: at("new", 2) };
    await driveExchange({ watermarks: {}, records: [r] });
    await driveExchange({ watermarks: { old: at("old", 1) }, records: [superseding] });
    const held = { old: at("old", 1), new: at("new", 2) };

    const statementsBefore = statements.length;
    const { response, store } = await driveExchange({ watermarks: held });
    expect(response.responderWatermarks).toEqual(held);
    expect(response.coverageComplete).not.toBe(false);
    expect(response.responderByteWatermarks).toEqual(held);
    expect(store.saves).toBe(0);
    // One watermark statement per source table on an idle Drive exchange.
    const idle = statements.slice(statementsBefore);
    expect(
      idle.filter((t) => /^select .* from "shared"\."node_watermarks_records"/.test(t)),
    ).toHaveLength(1);
    expect(
      idle.filter((t) => /^select .* from "shared"\."node_watermarks_labels"/.test(t)),
    ).toHaveLength(1);
  });

  it("drops a stored bytes author that no entry covers once, then saves nothing", async () => {
    // Live, three cloud authors were superseded before the tables existed, so
    // the backfill has no entry for them while the bytes store still did.
    const r = record(at("kept", 1));
    await driveExchange({ watermarks: {}, records: [r] });
    await pg.query(
      "INSERT INTO app_starkeep_drive._starkeep_byte_coverage VALUES ($1, 'gone', $2)",
      [A, s(at("gone", 0))],
    );
    const held = { kept: at("kept", 1) };

    const first = await driveExchange({ watermarks: held });
    expect(first.store.saves).toBe(1);
    expect(await createDsqlByteCoverageStore(client(), DRIVE, A).load()).toEqual(held);
    const second = await driveExchange({ watermarks: held });
    expect(second.store.saves).toBe(0);
  });

  it("reads a per-app channel's watermarks in one statement on an idle tick", async () => {
    await memoExchange({
      watermarks: {},
      appSyncableRows: [cardEntry("insert", "c1", at("desk", 1))],
    });
    const statementsBefore = statements.length;
    const response = await memoExchange({ watermarks: { desk: at("desk", 1) } });
    expect(response.responderWatermarks).toEqual({ desk: at("desk", 1) });
    const idle = statements.slice(statementsBefore);
    expect(idle.filter((t) => /_starkeep_node_watermarks/.test(t))).toHaveLength(1);
  });

  it("empties coverage on an uninstall and reinstall without keep-data, and the next round ships again", async () => {
    await memoExchange({
      watermarks: {},
      appSyncableRows: [cardEntry("insert", "c1", at("desk", 1))],
    });
    await uninstallMemo();
    await installMemo();

    const wiped = await memoExchange({ watermarks: { desk: at("desk", 1) } });
    expect(wiped.responderWatermarks).toEqual({});
    expect(wiped.coverageComplete).not.toBe(false);

    const reshipped = await memoExchange({
      watermarks: {},
      appSyncableRows: [cardEntry("insert", "c1", at("desk", 1))],
    });
    expect(reshipped.responderWatermarks).toEqual({ desk: at("desk", 1) });
  });

  it("reports incomplete coverage while an installed app lacks its watermark table", async () => {
    await pg.exec(`DROP TABLE ${APP_WATERMARKS}`);
    const response = await memoExchange({ watermarks: { desk: at("desk", 1) } });
    expect(response.coverageComplete).toBe(false);
  });
});
