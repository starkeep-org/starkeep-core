/**
 * Failure paths that had no injection at all, and the coverage report they hang
 * off.
 *
 * Three families, and they share one rule with the rest of the suite: **"I could
 * not look" is not "there is nothing there."** The branch had applied that rule
 * thoroughly to the scan path and not at all to four places on its edges — the
 * residency callbacks, the Drive channel's own two shared-record streams, the
 * response validator, and the responder's own coverage report.
 *
 * The last of those is the expensive one. There, "I could not look" was reported
 * as "I have nothing", and the requester's correct response to "I have nothing"
 * is to send everything — every tick, forever, with every signal reading as
 * success.
 */

import { describe, it, expect } from "vitest";
import {
  createDataRecord,
  generateId,
  serializeHLC,
  type HLCTimestamp,
  type StarkeepId,
} from "@starkeep/protocol-primitives";
import { createSyncEngine } from "../src/sync-engine.js";
import { createInProcessSyncTransport } from "../src/transports/in-process-transport.js";
import { createHttpSyncTransport } from "../src/transports/http-transport.js";
import { SyncError } from "../src/errors.js";
import { buildSide } from "./sync-test-harness/side.js";
import { createMemorySyncStateStore } from "./sync-test-harness/memory-sync-state.js";
import {
  failingDirectMethod,
  failingMethod,
} from "./sync-test-harness/failure-injection.js";
import type {
  AppSyncableRowEntry,
  ResidencyHooks,
  SyncExchangeRequest,
  SyncExchangeResponse,
  SyncStateStore,
  SyncTransport,
} from "../src/types.js";
import type { BlobCandidate, ResidencyVerdict } from "../src/residency-policy.js";

type Side = Awaited<ReturnType<typeof buildSide>>;

const APP_ID = "photos";

async function twoSides() {
  let t = 0;
  const wallClock = () => t++;
  return {
    local: await buildSide({ role: "local", nodeId: "L", wallClock, appId: APP_ID }),
    cloud: await buildSide({ role: "cloud", nodeId: "C", wallClock, appId: APP_ID }),
  };
}

/** A shared record carrying a blob, so the residency hooks are reached. */
async function seedRecordWithBlob(side: Side, sizeBytes = 16): Promise<StarkeepId> {
  const id = generateId() as StarkeepId;
  const key = `shared/test/photo/${id}`;
  await side.storage.put(key, new Uint8Array(sizeBytes).fill(7));
  await side.db.put({
    ...createDataRecord(
      {
        type: "image/jpeg",
        originAppId: APP_ID,
        contentHash: `sha256:${id}`,
        objectStorageKey: key,
        mimeType: "image/jpeg",
        sizeBytes,
      },
      side.clock,
    ),
    id,
  });
  return id;
}

/** A shared record with no blob, for cases about rows rather than bytes. */
async function seedRecord(side: Side): Promise<StarkeepId> {
  const id = generateId() as StarkeepId;
  await side.db.put({
    ...createDataRecord(
      {
        type: "@test/note",
        originAppId: APP_ID,
        contentHash: `sha256:${id}`,
        objectStorageKey: "",
        mimeType: "application/octet-stream",
        sizeBytes: 0,
      },
      side.clock,
    ),
    id,
  });
  return id;
}

async function seedAppRow(side: Side, table = "test_rows"): Promise<string> {
  const pk = generateId();
  const ts = side.clock.now();
  const entry: AppSyncableRowEntry = {
    appId: APP_ID,
    table,
    op: "insert",
    where: { id: pk },
    row: { id: pk, value: "v", updated_at: serializeHLC(ts), deleted_at: null },
    timestamp: ts,
  };
  await side.applier.apply(entry);
  return pk;
}

/** The Drive channel: shared records and labels, no app-syncable rows. */
function driveChannel(
  local: Side,
  cloud: Side,
  syncState: SyncStateStore,
  overrides: {
    localDb?: Side["db"];
    residency?: ResidencyHooks;
    transport?: SyncTransport;
  } = {},
) {
  const transport =
    overrides.transport ??
    createInProcessSyncTransport({
      databaseAdapter: cloud.db,
      clock: cloud.clock,
      objectStorage: cloud.storage,
      syncSharedRecords: true,
    });
  return createSyncEngine({
    localDatabaseAdapter: overrides.localDb ?? local.db,
    localObjectStorage: local.storage,
    remoteObjectStorage: cloud.storage,
    transport,
    clock: local.clock,
    syncState,
    syncSharedRecords: true,
    ...(overrides.residency ? { residency: overrides.residency } : {}),
  });
}

/** A per-app channel, with an optionally sabotaged responder-side applier. */
function appChannel(
  local: Side,
  cloud: Side,
  syncState: SyncStateStore,
  cloudApplier = cloud.applier,
) {
  const transport = createInProcessSyncTransport({
    databaseAdapter: cloud.db,
    clock: cloud.clock,
    objectStorage: cloud.storage,
    appSyncableSource: { namespaces: cloud.namespaces, applier: cloudApplier },
    syncSharedRecords: false,
  });
  return createSyncEngine({
    localDatabaseAdapter: local.db,
    localObjectStorage: local.storage,
    remoteObjectStorage: cloud.storage,
    transport,
    clock: local.clock,
    syncState,
    syncSharedRecords: false,
    appSyncableSource: { namespaces: local.namespaces, applier: local.applier },
  });
}

/** Hooks that always want the blob, so only the injected failure is in play. */
function wantEverything(over: Partial<ResidencyHooks> = {}): ResidencyHooks {
  return {
    decide: async (): Promise<ResidencyVerdict> => ({
      decision: "fetch",
      sizeClass: null,
      pinned: false,
      reason: "within-budget",
    }),
    ...over,
  };
}

// ---------------------------------------------------------------------------
// R4 — a throwing residency hook
// ---------------------------------------------------------------------------

describe("a residency hook that throws", () => {
  // Both hooks are host callbacks doing real I/O — `decide` runs a label query
  // plus a pin lookup, `onLanded` writes a row — and on a handset those are the
  // operations most likely to fail transiently. They were the one fallible thing
  // in the exchange with no catch, so a locked SQLite table took down the whole
  // round rather than holding one author's watermark for one tick.
  it("does not take down the round when decide() fails", async () => {
    const { local, cloud } = await twoSides();
    await seedRecordWithBlob(cloud);

    const engine = driveChannel(local, cloud, createMemorySyncStateStore(), {
      residency: wantEverything({
        decide: () => Promise.reject(new Error("[test] decider blew up")),
      }),
    });

    const result = await engine.exchange();
    // The round survives, and reports the item as not landed.
    expect(result.applied).toBe(0);
    expect(result.blocked).toBe(true);
  });

  it("does not take down the round when onLanded() fails", async () => {
    const { local, cloud } = await twoSides();
    await seedRecordWithBlob(cloud);

    const engine = driveChannel(local, cloud, createMemorySyncStateStore(), {
      residency: wantEverything({
        onLanded: () => Promise.reject(new Error("[test] accounting blew up")),
      }),
    });

    const result = await engine.exchange();
    expect(result.blocked).toBe(true);
  });

  // The property that matters: the watermark holds, so the peer offers the item
  // again. That is what makes a transient hook failure cost one round rather
  // than losing the record.
  it("holds the watermark, so the next round retries the item", async () => {
    const { local, cloud } = await twoSides();
    const id = await seedRecordWithBlob(cloud);
    const syncState = createMemorySyncStateStore();

    let failNext = true;
    const engine = driveChannel(local, cloud, syncState, {
      residency: wantEverything({
        decide: async (): Promise<ResidencyVerdict> => {
          if (failNext) {
            failNext = false;
            throw new Error("[test] transient decider failure");
          }
          return { decision: "fetch", sizeClass: null, pinned: false, reason: "within-budget" };
        },
      }),
    });

    await engine.exchange();
    expect(await local.db.get(id)).not.toBeNull();
    expect(await local.storage.has(`shared/test/photo/${id}`)).toBe(false);

    // Second round: the watermark never advanced past it, so it is offered
    // again and this time it lands.
    await engine.exchange();
    expect(await local.storage.has(`shared/test/photo/${id}`)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// R5 — the readable contract on the Drive channel
// ---------------------------------------------------------------------------

describe("an unreadable shared-record stream", () => {
  // `OutboundBacklog.readable` is documented as "every stream on this channel
  // answered", and on the Drive channel `querySince`/`queryLabelsSince` are the
  // *only* streams — so it could never be false there, and `verify()`'s
  // unreadable-outbound guard could never fire.
  it("makes verify() decline rather than compare", async () => {
    const { local, cloud } = await twoSides();
    await seedRecord(local);

    const engine = driveChannel(local, cloud, createMemorySyncStateStore(), {
      localDb: failingMethod(local.db, "querySince", {
        message: "[test] injected querySince failure",
      }),
    });

    const result = await engine.verify();
    // "Not checked", not "checked and clean". A comparison here would read an
    // unreadable table as a drained outbound side and report every bucket it
    // holds as loss on the peer's end.
    expect(result.supported).toBe(false);
    expect(result.divergentBuckets).toBe(0);
  });

  it("makes sync() hold the round rather than throwing out of it", async () => {
    const { local, cloud } = await twoSides();
    await seedRecord(local);

    const engine = driveChannel(local, cloud, createMemorySyncStateStore(), {
      localDb: failingMethod(local.db, "querySince", {
        message: "[test] injected querySince failure",
      }),
    });

    // Previously this threw. A logged, held round is the behaviour every other
    // stream on this engine already had.
    const result = await engine.sync();
    expect(result.complete).toBe(false);
    expect(result.shipped).toBe(0);
  });

  it("ships everything once the stream reads again", async () => {
    const { local, cloud } = await twoSides();
    await seedRecord(local);
    await seedRecord(local);

    // Two failures: the backlog check burns one and the round's own scan burns
    // the other, so the first `sync()` gets nothing across. The second is the
    // next tick, and the point of the case — a transient failure must cost a
    // round, not the records.
    const engine = driveChannel(local, cloud, createMemorySyncStateStore(), {
      localDb: failingMethod(local.db, "querySince", { failFor: 2 }),
    });

    const first = await engine.sync();
    expect(first.complete).toBe(false);
    expect(first.shipped).toBe(0);

    const second = await engine.sync();
    expect(second.complete).toBe(true);
    expect((await cloud.db.query({})).records).toHaveLength(2);
  });

  it("treats an unreadable label stream the same way", async () => {
    const { local, cloud } = await twoSides();
    // Deliberately nothing seeded. `hasOutboundBacklog` returns as soon as any
    // stream reports something owed, so a record here would answer the question
    // before the label stream was ever asked — and the case would pass without
    // touching the code it is about.
    const engine = driveChannel(local, cloud, createMemorySyncStateStore(), {
      localDb: failingMethod(local.db, "queryLabelsSince", {
        message: "[test] injected queryLabelsSince failure",
      }),
    });

    expect((await engine.verify()).supported).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// R12 — the responder's coverage report
// ---------------------------------------------------------------------------

describe("a responder that cannot read its own coverage", () => {
  /**
   * A responder whose per-table watermark query throws every round.
   *
   * The realistic causes are durable rather than transient — a per-app grant
   * that denies one table, schema drift after an app update, a DSQL error that
   * reproduces per request — which is what makes this worth a protocol field
   * rather than a retry.
   */
  function brokenCoverage(local: Side, cloud: Side, syncState: SyncStateStore) {
    return appChannel(local, cloud, syncState, brokenCoverageApplier(cloud));
  }

  /**
   * `failingDirectMethod` and not `failingMethod`: the finding is about a
   * responder that still *takes* rows while being unable to report what it
   * holds. `failingMethod` binds to the proxy, so the applier's own
   * `this.getNodeWatermarks(...)` inside `scanSince` would fail too, and a
   * responder whose scan is broken as well never hands anything back for the
   * requester to re-ship — the defect disappears behind a bigger one.
   */
  function brokenCoverageApplier(cloud: Side) {
    return failingDirectMethod(cloud.applier, "getNodeWatermarks", {
      message: "[test] cannot read coverage",
    });
  }

  it("says its report is incomplete rather than reporting nothing held", async () => {
    const { local, cloud } = await twoSides();
    await seedAppRow(local);

    const transport = createInProcessSyncTransport({
      databaseAdapter: cloud.db,
      clock: cloud.clock,
      objectStorage: cloud.storage,
      appSyncableSource: {
        namespaces: cloud.namespaces,
        applier: brokenCoverageApplier(cloud),
      },
      syncSharedRecords: false,
    });

    const response = await transport.exchange({ watermarks: {} });
    expect(response.coverageComplete).toBe(false);
    // And names the scope, so the requester can log which table.
    expect(response.coverageDetail).toContain("test_rows");
  });

  it("omits the field entirely when the report is whole", async () => {
    const { local, cloud } = await twoSides();
    await seedAppRow(local);
    const engine = appChannel(local, cloud, createMemorySyncStateStore());
    const result = await engine.exchange();
    // Absent reads as complete, which is what every responder too old to send
    // it means — so the ordinary round is unchanged.
    expect(result.peerCoverageDegraded).toBeUndefined();
  });

  /**
   * The finding itself: the endless re-ship is **bounded**, and it takes both
   * fixes to bound it.
   *
   * Before `coverageComplete`, the omitted author became a floor of `undefined`
   * on the requester, so the next scan started from the beginning of that
   * author's history. Nothing noticed — `progressed` is true because re-shipping
   * *is* progress, `sync()` returns `complete: true`, and the supervisor resets
   * its backoff and does it again 30 seconds later, forever.
   *
   * `coverageComplete` plus merge-upward does not, on its own, stop it here, and
   * that is not a gap in the fix. On a per-app channel the *entire* coverage
   * report comes from the failing scope, so the prior map is empty on the first
   * sync and `max(prior, reported)` is still empty. Round 3 says as much when it
   * asks for the backstop — "it also covers the case fix 1 cannot". So the
   * assertion is written against the pair: the syncs keep re-shipping, and then
   * they stop, having named the author rather than reporting success.
   */
  it("stops re-shipping the same rows, rather than doing it on every tick", async () => {
    const { local, cloud } = await twoSides();
    await seedAppRow(local);
    await seedAppRow(local);
    const syncState = createMemorySyncStateStore();
    const engine = brokenCoverage(local, cloud, syncState);

    const first = await engine.sync();
    expect(first.shipped).toBeGreaterThan(0);
    // Still shipping: the peer's report named no coverage at all for this
    // author, so there is nothing to merge upward and the scan floor holds.
    expect(first.refusedAuthors ?? []).toEqual([]);

    const second = await engine.sync();
    expect(second.shipped).toBeGreaterThan(0);

    // The third drained sync that re-shipped ground already shipped is the one
    // that trips the backstop.
    const third = await engine.sync();
    expect(third.refusedAuthors).toContain("L");
    expect(third.complete).toBe(false);

    // And the refusal is what actually stops the traffic — not just a label on
    // a round that ships anyway.
    const fourth = await engine.sync();
    expect(fourth.shipped).toBe(0);
    expect(fourth.refusedAuthors).toContain("L");
  });

  it("surfaces the degradation instead of leaving it in the responder's log", async () => {
    const { local, cloud } = await twoSides();
    await seedAppRow(local);
    const engine = brokenCoverage(local, cloud, createMemorySyncStateStore());

    const result = await engine.sync();
    // The only evidence used to be a `console.warn` on the responder — which in
    // the deployment that matters is a Lambda, so it landed in CloudWatch and
    // nowhere a user or the local node would ever see it.
    expect(result.peerCoverageDegraded).toContain("test_rows");
  });

  it("still applies what it was sent, rather than failing the exchange", async () => {
    const { local, cloud } = await twoSides();
    await seedAppRow(local);
    const engine = brokenCoverage(local, cloud, createMemorySyncStateStore());

    await engine.sync();
    // Deliberately not weaponized: an unreadable coverage report does not make
    // the round useless, and refusing the whole exchange would convert a
    // degraded report into a total sync outage for that app.
    expect([...cloud.appRows.keys()].length).toBeGreaterThan(0);
  });
});

describe("the repeat-shipment backstop", () => {
  /**
   * A responder that applies nothing and reports coverage of nothing.
   *
   * The case `coverageComplete` cannot cover: a peer that answers honestly,
   * claims to have applied what it received, and does not have it next time.
   * Everything local reads as a clean round.
   */
  function forgetfulPeer(): SyncTransport {
    return {
      async exchange(_request: SyncExchangeRequest): Promise<SyncExchangeResponse> {
        return {
          records: [],
          labels: [],
          appSyncableRows: [],
          responderWatermarks: {},
          hasMore: false,
        };
      },
    };
  }

  it("stops pushing an author after several drained syncs achieve nothing", async () => {
    const { local, cloud } = await twoSides();
    await seedRecord(local);
    const engine = driveChannel(local, cloud, createMemorySyncStateStore(), {
      transport: forgetfulPeer(),
    });

    // Three drained syncs shipping the same range without the peer's coverage
    // ever reaching it. Three rather than one because the honest reasons to
    // re-ship exist and are transient — a response lost after the peer applied,
    // a round abandoned mid-flight, a repair floor doing its job.
    const first = await engine.sync();
    expect(first.refusedAuthors ?? []).toEqual([]);
    await engine.sync();
    const third = await engine.sync();

    expect(third.refusedAuthors).toContain("L");
    // Not reported as a finished sync: rows this node holds are not reaching
    // the peer and no further retry will change that on its own.
    expect(third.complete).toBe(false);
  });

  it("does not count a sync that shipped new ground as a repeat", async () => {
    const { local, cloud } = await twoSides();
    const engine = driveChannel(local, cloud, createMemorySyncStateStore(), {
      transport: forgetfulPeer(),
    });

    // Each sync ships something *higher* than the last, which is what a large
    // backlog crossing over several syncs looks like. Counting that would
    // refuse an author for being slow.
    for (let i = 0; i < 4; i += 1) {
      await seedRecord(local);
      const result = await engine.sync();
      expect(result.refusedAuthors ?? []).toEqual([]);
    }
  });

  it("re-arms on verify(), which is the deliberate try-again", async () => {
    const { local, cloud } = await twoSides();
    await seedRecord(local);
    const engine = driveChannel(local, cloud, createMemorySyncStateStore(), {
      transport: forgetfulPeer(),
    });

    for (let i = 0; i < 3; i += 1) await engine.sync();
    expect((await engine.sync()).refusedAuthors).toContain("L");

    // A verification is what a person runs when they think sync is wrong, and
    // it is about to arm repairs off its answer. Holding a refusal across it
    // would mean the repair it arms cannot ship.
    await engine.verify();
    expect((await engine.sync()).refusedAuthors ?? []).toEqual([]);
  });

  it("clears the count once the peer's coverage catches up", async () => {
    const { local, cloud } = await twoSides();
    await seedRecord(local);
    const syncState = createMemorySyncStateStore();

    let forgetful = true;
    const realTransport = createInProcessSyncTransport({
      databaseAdapter: cloud.db,
      clock: cloud.clock,
      objectStorage: cloud.storage,
      syncSharedRecords: true,
    });
    const flaky: SyncTransport = {
      exchange: async (request) =>
        forgetful
          ? {
              records: [],
              labels: [],
              appSyncableRows: [],
              responderWatermarks: {},
              hasMore: false,
            }
          : realTransport.exchange(request),
    };

    const engine = driveChannel(local, cloud, syncState, { transport: flaky });
    await engine.sync();
    await engine.sync();

    forgetful = false;
    const recovered = await engine.sync();
    expect(recovered.refusedAuthors ?? []).toEqual([]);
    expect((await cloud.db.query({})).records).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// R3 — a malformed response must not be persisted
// ---------------------------------------------------------------------------

describe("a peer that answers with something that is not a watermark", () => {
  /**
   * The exact response R3 demonstrated with, delivered over the HTTP transport.
   *
   * It has to be the HTTP transport rather than a hand-rolled `SyncTransport`:
   * the validator lives at that boundary and nowhere else, deliberately.
   * `createInProcessSyncTransport` bypasses it entirely and an engine built over
   * one will faithfully persist whatever it is handed — which is correct, since
   * both ends of an in-process pair are the same process. A test that injects
   * junk anywhere but the wire is asserting against a layer that has no reason
   * to defend itself.
   */
  function junkWatermarks(): SyncTransport {
    const impl = (async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        records: [],
        labels: [],
        appSyncableRows: [],
        responderWatermarks: { L: "not-an-hlc" },
        hasMore: false,
      }),
    })) as unknown as typeof globalThis.fetch;
    return createHttpSyncTransport({ baseUrl: "https://cloud.example", fetch: impl });
  }

  // The demonstrated result was `{"rounds":2,"complete":true}` for a record that
  // never left, with `{"L":"not-an-hlc"}` written to disk and driving every
  // future scan. Both halves of that are asserted: the round is not called a
  // success, and nothing unusable is persisted.
  it("never lets the junk reach the persisted peer watermarks", async () => {
    const { local, cloud } = await twoSides();
    await seedRecord(local);
    const syncState = createMemorySyncStateStore();

    const engine = driveChannel(local, cloud, syncState, { transport: junkWatermarks() });
    await expect(engine.sync()).rejects.toThrow(SyncError);

    for (const hlc of Object.values(await syncState.getPeerWatermarks())) {
      expect(typeof hlc).toBe("object");
      expect(typeof (hlc as HLCTimestamp).wallTime).toBe("number");
    }
    // And the record it never shipped is still owed, rather than sitting behind
    // a watermark that claims it went across.
    expect((await cloud.db.query({})).records).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The abort signal
// ---------------------------------------------------------------------------

describe("sync({ signal })", () => {
  it("spends no round at all on an already-aborted signal", async () => {
    const { local, cloud } = await twoSides();
    await seedRecord(local);

    let rounds = 0;
    const counting: SyncTransport = {
      exchange: async () => {
        rounds += 1;
        return {
          records: [],
          labels: [],
          appSyncableRows: [],
          responderWatermarks: {},
          hasMore: false,
        };
      },
    };
    const engine = driveChannel(local, cloud, createMemorySyncStateStore(), {
      transport: counting,
    });

    // The check used to sit at the top of the *loop*, which is after the
    // pull-only round — so an aborted caller still bought one full exchange.
    // On a handset that is a real request over a real radio for someone who has
    // already gone away.
    const result = await engine.sync({ signal: { aborted: true } as AbortSignal });
    expect(rounds).toBe(0);
    expect(result.rounds).toBe(0);
  });
});
