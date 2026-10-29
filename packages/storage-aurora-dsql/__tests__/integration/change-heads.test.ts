/**
 * Every write the cloud makes to a synced table replaces its channel's change
 * head, in the same transaction, against real Postgres.
 *
 * An idle sync exchange is answered "unchanged" when the requester's token
 * still matches the head, so a write method that skipped the head would leave
 * its row unsynced until some other write. Every method below runs through
 * `guardChangeHeads`, the client the broker uses, which refuses the commit of
 * such a write; the assertions then check the head moved for the right
 * channel, for the right user, and for no other. PGlite stands in for DSQL for
 * the reason `app-syncable-conformance.test.ts` gives.
 *
 * See `change-heads.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { createDataRecord, createHLCClock, type DataRecord } from "@starkeep/protocol-primitives";
import type { AppSyncableNamespaceStore } from "@starkeep/shared-space-api";
import { AuroraDsqlDatabaseAdapter } from "../../src/adapter.js";
import { DsqlAppSyncableApplier } from "../../src/app-syncable/apply.js";
import { guardChangeHeads } from "../../src/change-heads.js";
import { assertOwnerScoped } from "../../src/owner-scope.js";
import type { DatabaseClient } from "../../src/types.js";
import { createSharedSchema } from "../pg-shared-schema.js";

const A = "user-a";
const B = "user-b";
const APP = "memo";

let pg: PGlite;

/** The client the broker builds: owner tripwire, then the change-head guard. */
function client(): DatabaseClient {
  return guardChangeHeads({
    async query(text, values) {
      assertOwnerScoped(text);
      const result = await pg.query(text, values as unknown[] | undefined);
      return { rows: result.rows as Record<string, unknown>[] };
    },
    async end() {},
  });
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

/** Every head, as `user/channel → token`. */
async function heads(): Promise<Record<string, string>> {
  const { rows } = await pg.query<{ user_id: string; channel: string; token: string }>(
    "SELECT user_id, channel, token FROM shared.change_heads",
  );
  return Object.fromEntries(rows.map((r) => [`${r.user_id}/${r.channel}`, r.token]));
}

/** Run `write` and return which heads it replaced. */
async function replacedBy(write: () => Promise<unknown>): Promise<string[]> {
  const before = await heads();
  await write();
  const after = await heads();
  return Object.keys(after)
    .filter((key) => after[key] !== before[key])
    .sort();
}

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
});

afterEach(async () => {
  await pg.close();
});

const clock = createHLCClock({ nodeId: "node-a" });

let seq = 0;
function photo(userId: string): DataRecord {
  const hash = (seq++).toString(16).padStart(64, "0");
  return createDataRecord(
    {
      type: "image/jpeg",
      originAppId: "photos",
      contentHash: hash,
      objectStorageKey: `shared/${userId}/image/aa/${hash}`,
      mimeType: "image/jpeg",
      sizeBytes: 10,
      originalFilename: `${hash}.jpg`,
    },
    clock,
  );
}

const label = (recordId: DataRecord["id"], value = "") => ({
  recordId,
  appId: "photos",
  key: "faces",
  value,
  recordType: "image/jpeg",
  hlc: clock.now(),
});

describe("shared writes replace the shared channel's head", () => {
  const SHARED = [`${A}/shared`];

  it.each([
    ["put", async (a: AuroraDsqlDatabaseAdapter) => a.put(photo(A))],
    ["delete", async (a: AuroraDsqlDatabaseAdapter, r: DataRecord) => a.delete(r.id, clock.now())],
    [
      "batch",
      async (a: AuroraDsqlDatabaseAdapter, r: DataRecord) =>
        a.batch([
          { type: "put", record: photo(A) },
          { type: "delete", id: r.id, hlc: clock.now() },
        ]),
    ],
    [
      "putMetadata",
      async (a: AuroraDsqlDatabaseAdapter, r: DataRecord) =>
        a.putMetadata("image/jpeg", { recordId: r.id, width: 4 }),
    ],
    [
      "tombstoneMetadata",
      async (a: AuroraDsqlDatabaseAdapter, r: DataRecord) =>
        a.tombstoneMetadata("image/jpeg", r.id, clock.now()),
    ],
    [
      "restoreMetadata",
      async (a: AuroraDsqlDatabaseAdapter, r: DataRecord) => a.restoreMetadata("image/jpeg", r.id),
    ],
    [
      "deleteMetadata",
      async (a: AuroraDsqlDatabaseAdapter, r: DataRecord) => a.deleteMetadata("image/jpeg", r.id),
    ],
    [
      "upsertLabels",
      async (a: AuroraDsqlDatabaseAdapter, r: DataRecord) => a.upsertLabels([label(r.id, "Ada")]),
    ],
    [
      "retractLabels",
      async (a: AuroraDsqlDatabaseAdapter, r: DataRecord) =>
        a.retractLabels([{ recordId: r.id, appId: "photos", key: "faces", hlc: clock.now() }]),
    ],
    [
      "replaceLabelValues",
      async (a: AuroraDsqlDatabaseAdapter, r: DataRecord) =>
        a.replaceLabelValues([
          {
            recordId: r.id,
            appId: "photos",
            key: "faces",
            values: ["Grace"],
            recordType: "image/jpeg",
            hlc: clock.now(),
          },
        ]),
    ],
    [
      "putLabel",
      async (a: AuroraDsqlDatabaseAdapter, r: DataRecord) => {
        const hlc = clock.now();
        await a.putLabel({
          recordId: r.id,
          appId: "photos",
          key: "faces",
          value: "Lin",
          recordType: "image/jpeg",
          createdAt: hlc,
          updatedAt: hlc,
          nodeId: hlc.nodeId,
          deletedAt: null,
        } as never);
      },
    ],
    [
      "tombstoneLabelsForRecord",
      async (a: AuroraDsqlDatabaseAdapter, r: DataRecord) =>
        a.tombstoneLabelsForRecord(r.id, clock.now()),
    ],
    [
      "restoreLabelsForRecord",
      async (a: AuroraDsqlDatabaseAdapter, r: DataRecord) => {
        const deletedAt = clock.now();
        await a.tombstoneLabelsForRecord(r.id, deletedAt);
        await a.restoreLabelsForRecord(r.id, deletedAt, clock.now());
      },
    ],
  ] as const)("%s", async (_name, write) => {
    const a = await adapterFor(A);
    const existing = photo(A);
    await a.put(existing);
    await a.upsertLabels([label(existing.id)]);
    await a.putMetadata("image/jpeg", { recordId: existing.id, width: 1 });

    expect(await replacedBy(() => write(a, existing))).toEqual(SHARED);
    expect(await a.changeHead()).toBe((await heads())[`${A}/shared`]);
  });

  it("leaves another user's head alone", async () => {
    const [a, b] = [await adapterFor(A), await adapterFor(B)];
    await b.put(photo(B));
    expect(await replacedBy(() => a.put(photo(A)))).toEqual(SHARED);
    expect(await b.changeHead()).not.toBe(await a.changeHead());
  });

  it("leaves the head alone for availability, which no exchange carries", async () => {
    const a = await adapterFor(A);
    await a.put(photo(A));
    expect(
      await replacedBy(() =>
        a.putAvailability({
          objectStorageKey: "shared/user-a/image/aa/x",
          state: "instant",
          observedAtMs: 1,
        } as never),
      ),
    ).toEqual([]);
  });

  it("reads no head before the channel's first write", async () => {
    expect(await (await adapterFor(A)).changeHead()).toBeNull();
  });
});

describe("app writes replace the app channel's head", () => {
  const entry = (op: "insert" | "update" | "delete", id: string) => {
    const timestamp = clock.now();
    const updatedAt = `${timestamp.wallTime.toString(16).padStart(12, "0")}:${timestamp.counter
      .toString(16)
      .padStart(4, "0")}:${timestamp.nodeId}`;
    return {
      timestamp,
      appId: APP,
      table: "cards",
      op,
      row: op === "delete" ? undefined : { id, front: op, updated_at: updatedAt },
      where: op === "insert" ? undefined : { id },
    } as never;
  };

  it.each(["insert", "update", "delete"] as const)("%s", async (op) => {
    const applier = new DsqlAppSyncableApplier(client(), namespaces, A);
    await applier.apply(entry("insert", "c1"));
    expect(await replacedBy(() => applier.apply(entry(op, "c1")))).toEqual([`${A}/app_memo`]);
    expect(await applier.changeHead(APP)).toBe((await heads())[`${A}/app_memo`]);
  });
});
