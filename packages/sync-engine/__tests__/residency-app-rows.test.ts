/**
 * Residency on the **app-syncable** path — a per-app channel's own files.
 *
 * `residency-exchange.test.ts` covers the shared-record path thoroughly and has
 * no `appSyncableRows` case at all, so two pieces of production code that only
 * this path reaches were untested: `candidateForAppRow`, which builds the
 * candidate from a `_starkeep_sync_records` row, and `labelInputs`' early return
 * for `candidate.appId !== null`.
 *
 * They are not a variation on the shared-record path. An app-syncable blob is a
 * different kind of thing at every step:
 *
 *   - it has **no labels**, so there is nothing to read and no ladder rung to
 *     resolve — the class is the app's namespace and a reserved rung;
 *   - it has **no parent**, so nothing can re-derive it, and this node may hold
 *     the only copy. Reading "re-derivable" off the namespace, as the class name
 *     alone would suggest, would make every app's own files freely deletable;
 *   - it arrives on a channel with `syncSharedRecords: false`, which is a
 *     different loop through `exchange()` than the one every existing residency
 *     test drives.
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { serializeHLC } from "@starkeep/protocol-primitives";
import { createSyncEngine } from "../src/sync-engine.js";
import { createInProcessSyncTransport } from "../src/transports/in-process-transport.js";
import { buildSide } from "./sync-test-harness/side.js";
import { FailingObjectStorageAdapter } from "./sync-test-harness/failure-injection.js";
import { FILE_RECORDS_TABLE } from "./sync-test-harness/mock-app-source.js";
import { createMemorySyncStateStore } from "./sync-test-harness/memory-sync-state.js";
import { UNCLASSIFIED_RUNG } from "../src/residency-manager.js";
import type {
  AppSyncableRowEntry,
  ResidencyHooks,
  SyncStateStore,
} from "../src/types.js";
import type { BlobCandidate, ResidencyVerdict } from "../src/residency-policy.js";

const APP_ID = "notes";

type Side = Awaited<ReturnType<typeof buildSide>>;

async function twoSides() {
  let t = 0;
  const wallClock = () => t++;
  return {
    local: await buildSide({ role: "local", nodeId: "L", wallClock, appId: APP_ID }),
    cloud: await buildSide({ role: "cloud", nodeId: "C", wallClock, appId: APP_ID }),
  };
}

/**
 * One row in the reserved file-records table, with real bytes behind it.
 *
 * Real bytes and a real hash because the transfer verifies the whole object as
 * it streams — a fixture with an invented content hash would fail the transfer
 * for the right reason and make the case look like a residency bug.
 */
async function seedAppFile(
  side: Side,
  options: { sizeBytes?: number; id?: string } = {},
): Promise<{ id: string; key: string; sizeBytes: number }> {
  const sizeBytes = options.sizeBytes ?? 24;
  const id = options.id ?? `file-${side.appRows.size + 1}`;
  const blob = Buffer.alloc(sizeBytes, 7);
  const hash = createHash("sha256").update(blob as unknown as Uint8Array).digest("hex");
  const key = `shared/image/${hash.slice(0, 2)}/${hash}`;
  await side.storage.put(key, blob);

  const ts = side.clock.now();
  const entry: AppSyncableRowEntry = {
    appId: APP_ID,
    table: FILE_RECORDS_TABLE,
    op: "insert",
    where: { id },
    row: {
      id,
      object_storage_key: key,
      content_hash: hash,
      mime_type: "image/jpeg",
      size_bytes: sizeBytes,
      updated_at: serializeHLC(ts),
      deleted_at: null,
    },
    timestamp: ts,
  };
  await side.applier.apply(entry);
  return { id, key, sizeBytes };
}

/** A per-app channel: app rows only, no shared records. */
function appChannel(
  local: Side,
  cloud: Side,
  syncState: SyncStateStore,
  residency?: ResidencyHooks,
) {
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
    ...(residency ? { residency } : {}),
  });
}

/** Hooks that record what they were asked and answer with a fixed decision. */
function recordingHooks(decision: ResidencyVerdict["decision"]): ResidencyHooks & {
  readonly asked: BlobCandidate[];
  readonly landed: BlobCandidate[];
} {
  const asked: BlobCandidate[] = [];
  const landed: BlobCandidate[] = [];
  return {
    asked,
    landed,
    decide: async (candidate): Promise<ResidencyVerdict> => {
      asked.push(candidate);
      return {
        decision,
        sizeClass: { namespace: APP_ID, rung: UNCLASSIFIED_RUNG, qualified: `${APP_ID}:${UNCLASSIFIED_RUNG}` },
        pinned: false,
        reason: decision === "fetch" ? "keep-all" : "budget-exhausted",
      };
    },
    onLanded: async (candidate) => {
      landed.push(candidate);
    },
  };
}

// ---------------------------------------------------------------------------
// r4 #7 — candidateForAppRow
// ---------------------------------------------------------------------------

describe("the candidate built from an app-syncable file row", () => {
  it("reaches the decider at all", async () => {
    const { local, cloud } = await twoSides();
    await seedAppFile(cloud);
    const hooks = recordingHooks("fetch");
    const engine = appChannel(local, cloud, createMemorySyncStateStore(), hooks);

    await engine.exchange();
    expect(hooks.asked).toHaveLength(1);
  });

  it("carries the owning app, which is where the namespace comes from", async () => {
    const { local, cloud } = await twoSides();
    const seeded = await seedAppFile(cloud, { sizeBytes: 40 });
    const hooks = recordingHooks("fetch");
    await appChannel(local, cloud, createMemorySyncStateStore(), hooks).exchange();

    expect(hooks.asked[0]).toMatchObject({
      appId: APP_ID,
      recordId: seeded.id,
      objectStorageKey: seeded.key,
      sizeBytes: 40,
    });
  });

  /**
   * `type: null` and `parentId: null`, and both matter downstream.
   *
   * A null type is what stops `capturedAtMs` asking the per-category metadata
   * table for a row that does not exist — an app-syncable file has no shared
   * record and therefore no category. A null parent is what makes
   * `requiresProof` true: nothing derived these bytes, so nothing can make them
   * again, and this node may hold the only copy.
   */
  it("declares no Starkeep type and no parent", async () => {
    const { local, cloud } = await twoSides();
    await seedAppFile(cloud);
    const hooks = recordingHooks("fetch");
    await appChannel(local, cloud, createMemorySyncStateStore(), hooks).exchange();

    expect(hooks.asked[0]!.type).toBeNull();
    expect(hooks.asked[0]!.parentId).toBeNull();
  });

  // The row's own `id` rather than the key, so the pin and open-time lookups —
  // both of which are keyed by record id — find this blob later.
  it("takes the record id from the row rather than from the key", async () => {
    const { local, cloud } = await twoSides();
    const seeded = await seedAppFile(cloud, { id: "note-attachment-1" });
    const hooks = recordingHooks("fetch");
    await appChannel(local, cloud, createMemorySyncStateStore(), hooks).exchange();

    expect(hooks.asked[0]!.recordId).toBe("note-attachment-1");
    expect(hooks.asked[0]!.recordId).not.toBe(seeded.key);
  });

  it("reports the same candidate to onLanded once the bytes arrive", async () => {
    const { local, cloud } = await twoSides();
    const seeded = await seedAppFile(cloud);
    const hooks = recordingHooks("fetch");
    await appChannel(local, cloud, createMemorySyncStateStore(), hooks).exchange();

    expect(await local.storage.has(seeded.key)).toBe(true);
    expect(hooks.landed.map((c) => c.recordId)).toEqual([seeded.id]);
  });

  /**
   * Only the reserved file-records table carries blobs. An ordinary app table's
   * rows have no `object_storage_key`, so asking the policy about them would be
   * asking a residency question about a row of text.
   */
  it("is not built for an ordinary app table's rows", async () => {
    const { local, cloud } = await twoSides();
    const ts = cloud.clock.now();
    await cloud.applier.apply({
      appId: APP_ID,
      table: "test_rows",
      op: "insert",
      where: { id: "row-1" },
      row: { id: "row-1", value: "v", updated_at: serializeHLC(ts), deleted_at: null },
      timestamp: ts,
    });

    const hooks = recordingHooks("fetch");
    await appChannel(local, cloud, createMemorySyncStateStore(), hooks).exchange();
    expect(hooks.asked).toHaveLength(0);
    // …and the row itself still crosses. No blob is not no sync.
    expect([...local.appRows.keys()].some((k) => k.includes("test_rows"))).toBe(true);
  });

  /**
   * A tombstone has no bytes to decide about, so nothing asks.
   *
   * Written as insert-sync-delete-sync rather than as a single round over an
   * already-deleted row, because the second shape is vacuous: on this channel a
   * tombstone for a row the peer never held matches nothing and the local side
   * sees no entry at all, so "the decider was not asked" would hold for a reason
   * that has nothing to do with tombstones. Here the same record demonstrably
   * *does* reach the decider on the first round and demonstrably does not on the
   * second.
   */
  it("is not built for a tombstone", async () => {
    const { local, cloud } = await twoSides();
    const seeded = await seedAppFile(cloud);
    const syncState = createMemorySyncStateStore();
    const hooks = recordingHooks("fetch");
    const engine = appChannel(local, cloud, syncState, hooks);

    await engine.sync();
    expect(hooks.asked.map((c) => c.recordId)).toEqual([seeded.id]);

    const ts = cloud.clock.now();
    await cloud.applier.apply({
      appId: APP_ID,
      table: FILE_RECORDS_TABLE,
      op: "delete",
      where: { id: seeded.id },
      timestamp: ts,
    });

    await engine.sync();
    // The tombstone crossed — the local row is soft-deleted — and no second
    // residency question was asked about it. Blob retention on delete is a GC
    // concern, not a sync one.
    expect(
      local.appRows.get(`${APP_ID}::${FILE_RECORDS_TABLE}::${seeded.id}`)?.["deleted_at"],
    ).toBeTruthy();
    expect(hooks.asked).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// r4 #8 — a decline advances the watermark on a shared-record-free channel
// ---------------------------------------------------------------------------

describe("eliding an app-syncable blob", () => {
  /**
   * The property the whole residency design rests on, asserted on the channel
   * shape it had never been asserted on.
   *
   * Every existing case for it runs on a channel with `syncSharedRecords: true`,
   * which is a different loop through `exchange()` — a decline there advances a
   * watermark that the shared-record half of the same round is also moving. Here
   * the app-row loop is the only thing advancing anything, so if the decline did
   * not advance it, nothing would.
   */
  it("advances the watermark, so the peer stops re-shipping the row", async () => {
    const { local, cloud } = await twoSides();
    const seeded = await seedAppFile(cloud);
    const syncState = createMemorySyncStateStore();
    const hooks = recordingHooks("elide");
    const engine = appChannel(local, cloud, syncState, hooks);

    const first = await engine.sync();
    expect(first.elided).toBeGreaterThan(0);
    expect(first.complete).toBe(true);
    // The bytes are not here, and that is a settled outcome rather than a
    // pending one.
    expect(await local.storage.has(seeded.key)).toBe(false);

    // The second round is offered nothing, because the watermark moved past it.
    const second = await engine.sync();
    expect(second.applied).toBe(0);
    expect(second.elided).toBe(0);
    expect(hooks.asked).toHaveLength(1);
  });

  // The metadata is the point of eliding: the node knows the file exists and
  // has chosen not to hold the bytes. Skipping the row too would make a decline
  // indistinguishable from never having heard of it.
  it("still applies the row it declined the bytes for", async () => {
    const { local, cloud } = await twoSides();
    const seeded = await seedAppFile(cloud);
    await appChannel(local, cloud, createMemorySyncStateStore(), recordingHooks("elide")).sync();

    expect(local.appRows.get(`${APP_ID}::${FILE_RECORDS_TABLE}::${seeded.id}`)).toMatchObject({
      id: seeded.id,
      object_storage_key: seeded.key,
    });
  });

  it("does not report an arrival for bytes that never arrived", async () => {
    const { local, cloud } = await twoSides();
    await seedAppFile(cloud);
    const hooks = recordingHooks("elide");
    await appChannel(local, cloud, createMemorySyncStateStore(), hooks).sync();
    expect(hooks.landed).toHaveLength(0);
  });

  /**
   * A *failed* fetch is not a decline, on this channel as on every other.
   *
   * The two look identical from outside — no bytes locally — and must not behave
   * identically: a decline is terminal and advances the watermark, a failure
   * holds it so the next round retries. Collapsing them is what made a phone
   * node impossible in the first place, and it is worth pinning here because
   * this loop reaches the contiguous-prefix rule by its own path.
   */
  it("holds the watermark when a wanted transfer fails instead", async () => {
    const { local, cloud } = await twoSides();
    const seeded = await seedAppFile(cloud);
    // `Side.storage` is declared as the plain adapter; the harness always wraps
    // it, and `setup-case.ts` narrows the same way before installing a rule.
    const injectable = local.storage as FailingObjectStorageAdapter;
    injectable.installRule({
      matches: (key: string) => key === seeded.key,
      recov: "persistent",
      label: "app-syncable blob never lands",
    });

    const hooks = recordingHooks("fetch");
    const engine = appChannel(local, cloud, createMemorySyncStateStore(), hooks);

    const first = await engine.sync();
    expect(first.complete).toBe(false);
    expect(await local.storage.has(seeded.key)).toBe(false);

    // Offered again, because the watermark never moved past it — the difference
    // between "I decided not to" and "it did not work".
    injectable.clearRules();
    await engine.sync();
    expect(await local.storage.has(seeded.key)).toBe(true);
  });

  // No residency hooks at all is the ordinary configuration for a laptop, and it
  // must mean "fetch everything" rather than "decide nothing and skip".
  it("fetches everything when the channel has no residency policy", async () => {
    const { local, cloud } = await twoSides();
    const seeded = await seedAppFile(cloud);
    await appChannel(local, cloud, createMemorySyncStateStore()).sync();
    expect(await local.storage.has(seeded.key)).toBe(true);
  });
});
