/**
 * What the digest can and cannot see — R7's scoping, and the limit that
 * survives it.
 *
 * The "counts, not checksums" argument the digest rests on is sound **per
 * table**: a restore loses a tail, a bad delete removes rows, and either moves
 * the count. It stops being sound the moment N tables are summed into one
 * counter, because that reintroduces the compensating-error case the argument
 * dismissed — five of one and two of another agrees with four and three, and a
 * 3.1-day bucket is wide enough for a loss and a write to land in the same one.
 *
 * R7 split the counter by data plane, and this file draws the line the split
 * actually falls on:
 *
 *   - **A row lost in one app table and gained in another is now detected.**
 *     Every app table is its own scope, so their counts no longer cancel.
 *   - **A record lost and a label gained is still masked.** Both are the
 *     `shared` scope, summed inside `DatabaseAdapter.bucketDigest` before any of
 *     this code sees them, so no amount of scoping above that line separates
 *     them.
 *
 * Round 3 asked for a test that "says which behaviour is intended" and round 4
 * for one that pins the limit even if the fix is deferred. Both are here, and
 * the difference between them is the point of the file.
 */
import { describe, it, expect } from "vitest";
import {
  createDataRecord,
  generateId,
  serializeHLC,
  type StarkeepId,
} from "@starkeep/protocol-primitives";
import {
  bucketsPeerIsMissing,
  foldDigestScopes,
  digestIsScoped,
  mergeDigestBuckets,
  type DigestBucket,
} from "@starkeep/storage-adapter";
import { createSyncEngine } from "../src/sync-engine.js";
import { createInProcessSyncTransport } from "../src/transports/in-process-transport.js";
import { buildSide } from "./sync-test-harness/side.js";
import { createMemorySyncStateStore } from "./sync-test-harness/memory-sync-state.js";
import type { AppSyncableRowEntry, SyncStateStore } from "../src/types.js";

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

function driveChannel(local: Side, cloud: Side, syncState: SyncStateStore) {
  return createSyncEngine({
    localDatabaseAdapter: local.db,
    localObjectStorage: local.storage,
    remoteObjectStorage: cloud.storage,
    transport: createInProcessSyncTransport({
      databaseAdapter: cloud.db,
      clock: cloud.clock,
      objectStorage: cloud.storage,
      syncSharedRecords: true,
    }),
    clock: local.clock,
    syncState,
    syncSharedRecords: true,
  });
}

function appChannel(local: Side, cloud: Side, syncState: SyncStateStore) {
  return createSyncEngine({
    localDatabaseAdapter: local.db,
    localObjectStorage: local.storage,
    remoteObjectStorage: cloud.storage,
    transport: createInProcessSyncTransport({
      databaseAdapter: cloud.db,
      clock: cloud.clock,
      objectStorage: cloud.storage,
      appSyncableSource: { namespaces: cloud.namespaces, applier: cloud.applier },
      syncSharedRecords: false,
    }),
    clock: local.clock,
    syncState,
    syncSharedRecords: false,
    appSyncableSource: { namespaces: local.namespaces, applier: local.applier },
  });
}

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

async function seedAppRow(side: Side, table: string): Promise<string> {
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

/** Remove a row behind the sync engine's back, the way a bad restore would. */
function loseAppRow(side: Side, table: string, pk: string): void {
  side.appRows.delete(`${APP_ID}::${table}::${pk}`);
}

function loseRecord(side: Side, id: StarkeepId): void {
  (side.db as unknown as { store: Map<string, unknown> }).store.delete(id);
}

// ---------------------------------------------------------------------------
// r4 #31 — the swap R7 now catches
// ---------------------------------------------------------------------------

describe("a compensating swap across two app tables", () => {
  /**
   * The scenario, on the channel shape where it can actually occur.
   *
   * A per-app channel carries several of one app's tables. Before scoping, all
   * of them were summed into one counter per `(author, bucket)`, so a row lost
   * from `test_rows` and a row written to `_starkeep_sync_records` inside the
   * same 3.1-day bucket produced an identical total — and `verify()`, the one
   * check that would ever find the loss, reported clean.
   *
   * The whole harness runs on a single monotonic wall clock, so every row seeded
   * here lands in one bucket by construction. That is what makes the case sharp
   * rather than incidental.
   */
  async function swapped() {
    const { local, cloud } = await twoSides();
    const syncState = createMemorySyncStateStore();
    const engine = appChannel(local, cloud, syncState);

    const lost: string[] = [];
    for (let i = 0; i < 4; i += 1) lost.push(await seedAppRow(local, "test_rows"));
    await engine.sync();

    // The peer loses one row of one table and gains one of another. Its total
    // row count is unchanged, and so is the count in this author's bucket.
    loseAppRow(cloud, "test_rows", lost[1]!);
    await seedAppRow(cloud, "_starkeep_sync_records");

    return { local, cloud, engine, syncState };
  }

  it("is detected, rather than cancelling out", async () => {
    const { engine } = await swapped();
    const result = await engine.verify();

    expect(result.supported).toBe(true);
    // The unscoped total agrees; the scoped comparison does not.
    expect(result.divergentBuckets).toBeGreaterThan(0);
  });

  it("arms a repair floor for the author whose row went missing", async () => {
    const { engine, syncState } = await swapped();
    await engine.verify();
    expect(Object.keys(await syncState.getRepairFloors())).toEqual(["L"]);
  });

  it("re-ships the lost row on the next sync", async () => {
    const { cloud, engine } = await swapped();
    await engine.verify();
    await engine.sync();
    // Four rows again in the table that lost one.
    const rows = [...cloud.appRows.keys()].filter((k) => k.includes("::test_rows::"));
    expect(rows).toHaveLength(4);
  });

  // The control: without the swap the same setup reports clean, so the cases
  // above are detecting the loss rather than an artefact of the fixture.
  it("reports agreement when nothing was lost", async () => {
    const { local, cloud } = await twoSides();
    const engine = appChannel(local, cloud, createMemorySyncStateStore());
    for (let i = 0; i < 4; i += 1) await seedAppRow(local, "test_rows");
    await engine.sync();

    const result = await engine.verify();
    expect(result.supported).toBe(true);
    expect(result.divergentBuckets).toBe(0);
    expect(result.missingLocally).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// r3 #9 — the swap that is still masked, and why
// ---------------------------------------------------------------------------

describe("a compensating swap between a record and a label", () => {
  /**
   * **This is a known limit, not a passing feature**, and the assertion says so
   * rather than pretending otherwise.
   *
   * Round 3 asks for the case where "the peer lost a record and gained a label".
   * R7 does not reach it: records and labels are both the `shared` scope, and —
   * more to the point — they are summed together inside
   * `DatabaseAdapter.bucketDigest` itself, one level below anything this package
   * tags. No amount of scoping above that line can separate two counts that
   * arrived already added up.
   *
   * Fixing it means splitting `bucketDigest`'s own return into a record scope
   * and a label scope, in every applier that implements it. That is a protocol
   * and conformance change rather than a call-site one, which is why it is
   * pinned here instead of fixed in passing.
   */
  it("is still reported as agreement — the limit, stated", async () => {
    const { local, cloud } = await twoSides();
    const syncState = createMemorySyncStateStore();
    const engine = driveChannel(local, cloud, syncState);

    const ids: StarkeepId[] = [];
    for (let i = 0; i < 4; i += 1) ids.push(await seedRecord(local));
    await engine.sync();

    // The peer loses a record and gains a label **authored by the same node, in
    // the same bucket**. Both halves are required for the swap to cancel:
    // buckets are keyed by `(nodeId, bucket, scope)`, so a label the peer wrote
    // itself would land in a different author's bucket and compensate nothing.
    // A label authored by L and delivered to the peer by some other route is the
    // realistic shape — and the one the digest cannot see.
    const lost = (await cloud.db.get(ids[1]!))!;
    loseRecord(cloud, ids[1]!);
    await cloud.db.putLabel({
      recordId: ids[0]!,
      appId: APP_ID,
      key: "archived",
      value: "v",
      recordType: lost.type,
      createdAt: lost.updatedAt,
      updatedAt: lost.updatedAt,
      nodeId: lost.updatedAt.nodeId,
      deletedAt: null,
    });

    const result = await engine.verify();
    expect(result.supported).toBe(true);
    // If this ever starts failing, the limit has been closed and this case
    // should become an assertion that the loss *is* detected.
    expect(result.divergentBuckets).toBe(0);
    expect(await cloud.db.get(ids[1]!)).toBeNull();
  });

  // The half that is not masked, so the limit is bounded rather than open: an
  // *uncompensated* record loss on the same channel is still caught. The digest
  // is not blind to shared records — it is blind to one exact cancellation.
  it("still catches the same loss when nothing compensates for it", async () => {
    const { local, cloud } = await twoSides();
    const engine = driveChannel(local, cloud, createMemorySyncStateStore());

    const ids: StarkeepId[] = [];
    for (let i = 0; i < 4; i += 1) ids.push(await seedRecord(local));
    await engine.sync();

    loseRecord(cloud, ids[1]!);
    const result = await engine.verify();
    expect(result.divergentBuckets).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Version skew — a peer that cannot express scopes
// ---------------------------------------------------------------------------

describe("comparing against a peer whose digest carries no scopes", () => {
  /**
   * Both sides fold rather than one side refusing.
   *
   * Comparing scoped buckets against unscoped ones would make every bucket
   * disagree over a missing *field*, manufacturing precisely the whole-library
   * repair the prefix-length and scope-set guards exist to prevent. So the
   * comparison drops to the coarser precision both sides can express, which is
   * the same rule applied everywhere else on this branch: claim only what the
   * evidence supports.
   */
  it("does not read a missing scope field as whole-library divergence", async () => {
    const { local, cloud } = await twoSides();
    const syncState = createMemorySyncStateStore();
    const transport = createInProcessSyncTransport({
      databaseAdapter: cloud.db,
      clock: cloud.clock,
      objectStorage: cloud.storage,
      appSyncableSource: { namespaces: cloud.namespaces, applier: cloud.applier },
      syncSharedRecords: false,
    });
    const engine = createSyncEngine({
      localDatabaseAdapter: local.db,
      localObjectStorage: local.storage,
      remoteObjectStorage: cloud.storage,
      // An older peer: same counts, no `scope` on any bucket.
      transport: {
        async exchange(request) {
          const response = await transport.exchange(request);
          if (!response.digest) return response;
          return {
            ...response,
            digest: foldDigestScopes(response.digest),
          };
        },
      },
      clock: local.clock,
      syncState,
      syncSharedRecords: false,
      appSyncableSource: { namespaces: local.namespaces, applier: local.applier },
    });

    for (let i = 0; i < 4; i += 1) await seedAppRow(local, "test_rows");
    await engine.sync();

    const result = await engine.verify();
    expect(result.supported).toBe(true);
    expect(result.divergentBuckets).toBe(0);
    expect(result.missingLocally).toBe(0);
    expect(await syncState.getRepairFloors()).toEqual({});
    expect(await syncState.getInboundFloors()).toEqual({});
  });

  // The cost of talking to such a peer, stated: the compensating swap the
  // scoped comparison catches goes back to being invisible. A limit of the
  // conversation rather than something this side can fix.
  it("loses the ability to see a compensating swap against it", async () => {
    const local: DigestBucket[] = [
      { nodeId: "L", bucket: "0001", count: 4, scope: "photos.test_rows" },
      { nodeId: "L", bucket: "0001", count: 1, scope: "photos._starkeep_sync_records" },
    ];
    const peerSwapped: DigestBucket[] = [
      { nodeId: "L", bucket: "0001", count: 3, scope: "photos.test_rows" },
      { nodeId: "L", bucket: "0001", count: 2, scope: "photos._starkeep_sync_records" },
    ];

    expect(bucketsPeerIsMissing(local, peerSwapped)).toHaveLength(1);
    expect(
      bucketsPeerIsMissing(foldDigestScopes(local), foldDigestScopes(peerSwapped)),
    ).toHaveLength(0);
  });

  // Folding is a sum, not a discard: the coarse comparison still catches an
  // uncompensated loss, which is what makes talking to an older peer worth
  // doing at all.
  it("still catches an uncompensated loss after folding", () => {
    const local: DigestBucket[] = [
      { nodeId: "L", bucket: "0001", count: 4, scope: "photos.test_rows" },
      { nodeId: "L", bucket: "0001", count: 1, scope: "photos._starkeep_sync_records" },
    ];
    const peerShort = [{ nodeId: "L", bucket: "0001", count: 4 }];
    expect(bucketsPeerIsMissing(foldDigestScopes(local), peerShort)).toHaveLength(1);
    expect(foldDigestScopes(local)).toEqual([{ nodeId: "L", bucket: "0001", count: 5 }]);
  });

  it("keys unscoped buckets apart from scoped ones rather than merging them", () => {
    const mixed = mergeDigestBuckets([
      { nodeId: "L", bucket: "0001", count: 2, scope: "photos.test_rows" },
      { nodeId: "L", bucket: "0001", count: 3 },
    ]);
    // Two entries, not one of five. A scope-less bucket is a different fact
    // from a scoped one and summing them would invent a count neither side
    // reported.
    expect(mixed).toHaveLength(2);
    expect(digestIsScoped(mixed)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// r4 #32 — NOT_VERIFIED is never a clean result
// ---------------------------------------------------------------------------

/**
 * Every path out of `verify()` that declines to compare returns the *same*
 * refusal, and the refusal is inert.
 *
 * The risk is not that `supported` comes back true — each path returns the one
 * `NOT_VERIFIED` constant — but that a path reaches its refusal *after* having
 * already armed something, or that it reports a non-zero count a caller then
 * displays. So each case asserts the whole shape rather than the flag: no
 * divergence claimed in either direction, and no floor written.
 *
 * The individual causes are covered next door (`round-budget.test.ts` for the
 * prefix and scope-set mismatches and an unreadable local digest,
 * `residency-and-coverage-failures.test.ts` for an unreadable outbound stream).
 * What is asserted here is the property they share, which no single one of them
 * states.
 */
describe("every verify() refusal", () => {
  async function refusalFrom(
    sabotage: (parts: {
      local: Side;
      cloud: Side;
      transport: ReturnType<typeof createInProcessSyncTransport>;
    }) => ReturnType<typeof createInProcessSyncTransport> | void,
  ) {
    const { local, cloud } = await twoSides();
    const syncState = createMemorySyncStateStore();
    const transport = createInProcessSyncTransport({
      databaseAdapter: cloud.db,
      clock: cloud.clock,
      objectStorage: cloud.storage,
      syncSharedRecords: true,
    });
    for (let i = 0; i < 4; i += 1) await seedRecord(local);

    const replacement = sabotage({ local, cloud, transport });
    const engine = createSyncEngine({
      localDatabaseAdapter: local.db,
      localObjectStorage: local.storage,
      remoteObjectStorage: cloud.storage,
      transport: replacement ?? transport,
      clock: local.clock,
      syncState,
      syncSharedRecords: true,
    });
    await engine.sync();
    return { engine, syncState };
  }

  const causes: Array<
    [string, Parameters<typeof refusalFrom>[0]]
  > = [
    [
      "a peer that sends no digest at all",
      ({ transport }) => ({
        async exchange(request) {
          const { digest: _dropped, ...rest } = await transport.exchange(request);
          return rest;
        },
      }),
    ],
    [
      "a peer bucketing at a different width",
      ({ transport }) => ({
        async exchange(request) {
          const response = await transport.exchange(request);
          return response.digest ? { ...response, digestPrefixLength: 3 } : response;
        },
      }),
    ],
    [
      "a peer counting a different set of tables",
      ({ transport }) => ({
        async exchange(request) {
          const response = await transport.exchange(request);
          return response.digest
            ? { ...response, digestScopes: [...(response.digestScopes ?? []), "notes.pages"] }
            : response;
        },
      }),
    ],
    [
      "a local digest that would not read",
      ({ local }) => {
        local.db.bucketDigest = async () => {
          throw new Error("[test] local digest read failure");
        };
      },
    ],
    [
      "a local outbound stream that would not read",
      ({ local }) => {
        local.db.querySince = async () => {
          throw new Error("[test] outbound scan failure");
        };
      },
    ],
  ];

  it.each(causes)("declines rather than reporting clean: %s", async (_label, sabotage) => {
    const { engine, syncState } = await refusalFrom(sabotage);
    const result = await engine.verify();

    expect(result.supported).toBe(false);
    // Nothing claimed in either direction. A zero beside `supported: false` is
    // "not checked"; a zero beside `supported: true` is "checked and clean", and
    // the whole reason the flag exists is that a caller must be able to tell.
    expect(result.divergentBuckets).toBe(0);
    expect(result.missingLocally).toBe(0);
    // And nothing armed on the way to the refusal, which is the part a
    // per-cause test does not assert.
    expect(await syncState.getRepairFloors()).toEqual({});
    expect(await syncState.getInboundFloors()).toEqual({});
  });

  // The control, so the property above is not satisfied by a `verify()` that
  // refuses everything.
  it("reports supported for a peer that answers properly", async () => {
    const { engine } = await refusalFrom(() => undefined);
    expect((await engine.verify()).supported).toBe(true);
  });
});
