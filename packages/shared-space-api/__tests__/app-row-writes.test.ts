/**
 * An app's own row writes, between the factory and the HTTP answer.
 *
 * Two rules live here. A write wakes the sync loop only when it changed a row,
 * so a reseed that skips every starter row on launch costs no sync round. And
 * one mapping turns a write's outcome into the status both data servers answer.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createHLCClock } from "@starkeep/protocol-primitives";
import { MockObjectStorageAdapter } from "@starkeep/storage-adapter";
import type {
  AppSyncableApplyOutcome,
  AppSyncableNamespace,
  AppSyncableRowEntry,
  AppSyncableWriteConditions,
  ChangeEvent,
} from "@starkeep/sync-engine";
import { createAppSpecificFactory, rowWriteResponse } from "../src/index.js";
import type { AppSpecificOperations } from "../src/types.js";

const namespace: AppSyncableNamespace = {
  appId: "notes",
  filesEnabled: false,
  tableNames: ["notes"],
  tables: [
    {
      name: "notes",
      pkColumns: ["id"],
      columns: [
        { name: "id", type: "text", notNull: true, primaryKey: true },
        { name: "body", type: "text", notNull: false, primaryKey: false },
      ],
    },
  ],
};

let next: AppSyncableApplyOutcome;
let applied: { entry: AppSyncableRowEntry; conditions?: AppSyncableWriteConditions }[];
let wakeUps: ChangeEvent[];
let ops: AppSpecificOperations;

beforeEach(() => {
  next = { changes: 1 };
  applied = [];
  wakeUps = [];
  const factory = createAppSpecificFactory({
    namespace: { get: (id) => (id === "notes" ? namespace : null), list: () => [namespace] },
    applier: {
      apply(entry, conditions) {
        applied.push({ entry, conditions });
        return next;
      },
    },
    fileStorage: new MockObjectStorageAdapter(),
    clock: createHLCClock({ nodeId: "node-a" }),
    changeNotifier: { subscribe: () => () => {}, emit: (event) => wakeUps.push(event) },
    userId: () => "local",
  });
  ops = factory({ subjectType: "app", subjectId: "notes" })!;
});

describe("sync wake-up", () => {
  it("wakes the sync loop once for each write that changed a row", async () => {
    await ops.insertRow("notes", { id: "n1", body: "a" });
    await ops.updateRow("notes", { id: "n1" }, { body: "b" });
    await ops.deleteRow("notes", { id: "n1" });
    expect(wakeUps).toHaveLength(3);
    expect(wakeUps.every((e) => e.eventType === "local-change-recorded")).toBe(true);
    expect(wakeUps.every((e) => e.originAppId === "notes")).toBe(true);
  });

  it("leaves the sync loop asleep for a write that changed nothing", async () => {
    next = { changes: 0, skipped: "live" };
    const result = await ops.insertRow("notes", { id: "n1", body: "seed" }, { ifAbsent: true });
    expect(result).toEqual({ changes: 0, skipped: "live" });
    next = { changes: 0, skipped: "deleted" };
    await ops.updateRow("notes", { id: "n1" }, { body: "b" });
    next = { changes: 0, skipped: "missing" };
    await ops.deleteRow("notes", { id: "n2" });
    expect(applied).toHaveLength(3);
    expect(wakeUps).toEqual([]);
  });

  it("asks the applier for a reason on every app write, even without options", async () => {
    await ops.insertRow("notes", { id: "n1", body: "a" });
    await ops.updateRow("notes", { id: "n1" }, { body: "b" });
    await ops.deleteRow("notes", { id: "n1" });
    expect(applied.map((a) => a.conditions)).toEqual([{}, {}, {}]);
  });
});

describe("rowWriteResponse", () => {
  const methods = ["POST", "PATCH", "DELETE"] as const;

  it.each(methods)("answers 409 for a superseded %s without claiming a stamp", (method) => {
    const res = rowWriteResponse(method, { changes: 0, skipped: "superseded" });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ changes: 0, skipped: "superseded" });
    expect(String(res.body["error"])).not.toMatch(/stamp/);
  });

  it("answers 409 for a stale PATCH or DELETE with the stamp message", () => {
    for (const method of ["PATCH", "DELETE"] as const) {
      const res = rowWriteResponse(method, { changes: 0, skipped: "stale" });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({
        error: "The row changed since the stamp the write named",
        changes: 0,
        skipped: "stale",
      });
    }
  });

  it("answers 200 for a skipped ifAbsent POST", () => {
    expect(rowWriteResponse("POST", { changes: 0, skipped: "live" })).toEqual({
      status: 200,
      body: { ok: true, changes: 0, skipped: "live" },
    });
  });

  it("answers 404 with skipped missing for a write that found no live row", () => {
    const body = { error: "No live row holds that key", changes: 0, skipped: "missing" };
    expect(rowWriteResponse("PATCH", { changes: 0, skipped: "missing" })).toEqual({
      status: 404,
      body,
    });
    expect(rowWriteResponse("DELETE", { changes: 0, skipped: "missing" })).toEqual({
      status: 404,
      body,
    });
    // A deleted row answers a PATCH exactly as a key no row ever held.
    expect(rowWriteResponse("PATCH", { changes: 0, skipped: "deleted" })).toEqual({
      status: 404,
      body,
    });
  });

  it("answers 200 for a DELETE of a deleted row", () => {
    expect(rowWriteResponse("DELETE", { changes: 0, skipped: "deleted" })).toEqual({
      status: 200,
      body: { changes: 0, skipped: "deleted" },
    });
  });
});
