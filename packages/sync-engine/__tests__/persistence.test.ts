import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  createHLCClock,
  createDataRecord,
  type HLCTimestamp,
} from "@starkeep/core";
import { createSqliteChangeLog } from "../src/change-log-sqlite.js";
import { createSqliteSyncStateStore } from "../src/sync-state-sqlite.js";

function makeDb() {
  return new DatabaseSync(":memory:");
}

describe("createSqliteChangeLog", () => {
  it("appends and retrieves entries by range", async () => {
    const db = makeDb();
    const log = createSqliteChangeLog({ db });
    const clock = createHLCClock({ nodeId: "n", wallClockFunction: () => 1000 });
    const r = createDataRecord({ type: "@t/x", ownerId: "u", originAppId: "@starkeep/sync-engine" }, clock);

    await log.append({
      recordId: r.id,
      operation: "create",
      timestamp: { wallTime: 1000, counter: 0, nodeId: "n" },
      recordSnapshot: r,
      baseVersion: null,
    });

    const since: HLCTimestamp = { wallTime: 500, counter: 0, nodeId: "" };
    const results = await log.getChangesSince(since);
    expect(results).toHaveLength(1);
    expect(results[0].recordId).toBe(r.id);
    expect(results[0].baseVersion).toBeNull();
    expect(results[0].recordSnapshot.id).toBe(r.id);
  });

  it("respects HLC ordering when filtering", async () => {
    const db = makeDb();
    const log = createSqliteChangeLog({ db });
    const clock = createHLCClock({ nodeId: "n", wallClockFunction: () => 1 });
    const r1 = createDataRecord({ type: "@t/x", ownerId: "u", originAppId: "@starkeep/sync-engine" }, clock);
    const r2 = createDataRecord({ type: "@t/x", ownerId: "u", originAppId: "@starkeep/sync-engine" }, clock);

    await log.append({
      recordId: r1.id,
      operation: "create",
      timestamp: { wallTime: 1000, counter: 0, nodeId: "n" },
      recordSnapshot: r1,
      baseVersion: null,
    });
    await log.append({
      recordId: r2.id,
      operation: "create",
      timestamp: { wallTime: 1000, counter: 5, nodeId: "n" },
      recordSnapshot: r2,
      baseVersion: null,
    });

    const since: HLCTimestamp = { wallTime: 1000, counter: 2, nodeId: "n" };
    const results = await log.getChangesSince(since);
    expect(results).toHaveLength(1);
    expect(results[0].recordId).toBe(r2.id);
  });

  it("survives a second change log attaching to the same DB", async () => {
    const db = makeDb();
    const log = createSqliteChangeLog({ db });
    const clock = createHLCClock({ nodeId: "n", wallClockFunction: () => 1 });
    const r = createDataRecord({ type: "@t/x", ownerId: "u", originAppId: "@starkeep/sync-engine" }, clock);
    await log.append({
      recordId: r.id,
      operation: "create",
      timestamp: { wallTime: 10, counter: 0, nodeId: "n" },
      recordSnapshot: r,
      baseVersion: null,
    });

    const log2 = createSqliteChangeLog({ db });
    const results = await log2.getChangesSince({ wallTime: 0, counter: 0, nodeId: "" });
    expect(results).toHaveLength(1);
    expect(results[0].recordId).toBe(r.id);
  });

  it("prunes old entries", async () => {
    const db = makeDb();
    const log = createSqliteChangeLog({ db });
    const clock = createHLCClock({ nodeId: "n", wallClockFunction: () => 1 });
    const r1 = createDataRecord({ type: "@t/x", ownerId: "u", originAppId: "@starkeep/sync-engine" }, clock);
    const r2 = createDataRecord({ type: "@t/x", ownerId: "u", originAppId: "@starkeep/sync-engine" }, clock);
    await log.append({
      recordId: r1.id,
      operation: "create",
      timestamp: { wallTime: 100, counter: 0, nodeId: "n" },
      recordSnapshot: r1,
      baseVersion: null,
    });
    await log.append({
      recordId: r2.id,
      operation: "create",
      timestamp: { wallTime: 200, counter: 0, nodeId: "n" },
      recordSnapshot: r2,
      baseVersion: null,
    });

    const removed = await log.prune({ wallTime: 150, counter: 0, nodeId: "n" });
    expect(removed).toBe(1);
  });
});

describe("createSqliteSyncStateStore", () => {
  it("round-trips pull and push cursors", async () => {
    const db = makeDb();
    const store = createSqliteSyncStateStore({ db });

    expect(await store.getPullCursor()).toBeNull();
    expect(await store.getPushCursor()).toBeNull();

    const pullCursor: HLCTimestamp = { wallTime: 1234, counter: 5, nodeId: "cloud" };
    await store.setPullCursor(pullCursor);
    const pushCursor: HLCTimestamp = { wallTime: 9999, counter: 0, nodeId: "local" };
    await store.setPushCursor(pushCursor);

    const store2 = createSqliteSyncStateStore({ db });
    expect(await store2.getPullCursor()).toEqual(pullCursor);
    expect(await store2.getPushCursor()).toEqual(pushCursor);
  });

  it("round-trips HLC clock state", async () => {
    const db = makeDb();
    const store = createSqliteSyncStateStore({ db });

    expect(await store.getHlcClockState()).toBeNull();
    await store.setHlcClockState({ wallTime: 12345, counter: 7 });

    const store2 = createSqliteSyncStateStore({ db });
    expect(await store2.getHlcClockState()).toEqual({ wallTime: 12345, counter: 7 });
  });
});

describe("HLC clock persistence", () => {
  it("onTick fires on every now()", () => {
    const ticks: Array<{ wallTime: number; counter: number }> = [];
    const clock = createHLCClock({
      nodeId: "n",
      wallClockFunction: () => 1000,
      onTick: (state) => ticks.push(state),
    });
    clock.now();
    clock.now();
    clock.now();
    expect(ticks).toHaveLength(3);
    expect(ticks[0].wallTime).toBe(1000);
  });

  it("initialState seeds counter so post-restart HLC never regresses", () => {
    const state = { wallTime: 1000, counter: 5 };
    const clock = createHLCClock({
      nodeId: "n",
      wallClockFunction: () => 1000,
      initialState: state,
    });
    const ts = clock.now();
    expect(ts.wallTime).toBe(1000);
    expect(ts.counter).toBeGreaterThan(5);
  });
});
