import { createMemorySyncStateStore } from "./sync-test-harness/memory-sync-state.js";
import { describe, it, expect } from "vitest";
import {
  createDataRecord,
  type DataRecord,
  type StandInRole,
  type StarkeepId,
} from "@starkeep/protocol-primitives";
import { createSyncEngine } from "../src/sync-engine.js";
import { createInProcessSyncTransport } from "../src/transports/in-process-transport.js";
import { buildSide } from "./sync-test-harness/side.js";
import type { SyncStateStore } from "../src/types.js";

/**
 * Two stand-ins for one slot, produced on two nodes while each was offline.
 *
 * The rule under test: the cloud's first commit wins, the loser dies by an
 * ordinary tombstone on every side, and nothing about it stops sync — a unique
 * violation inside an apply would otherwise stop the whole channel.
 */
describe("stand-in slot collisions across nodes", () => {
  type Side = Awaited<ReturnType<typeof buildSide>>;

  async function sides() {
    let t = 0;
    const wallClock = () => t++;
    return {
      a: await buildSide({ role: "local", nodeId: "A", wallClock, appId: "photos" }),
      b: await buildSide({ role: "local", nodeId: "B", wallClock, appId: "photos" }),
      cloud: await buildSide({ role: "cloud", nodeId: "C", wallClock, appId: "photos" }),
    };
  }

  function engine(
    local: Side,
    cloud: Side,
    opts: {
      syncState?: SyncStateStore;
      keepLiveOnTombstone?: Parameters<typeof createInProcessSyncTransport>[0]["keepLiveOnTombstone"];
      reviseIncoming?: Parameters<typeof createInProcessSyncTransport>[0]["reviseIncoming"];
      onApplied?: Parameters<typeof createInProcessSyncTransport>[0]["onApplied"];
    } = {},
  ) {
    const transport = createInProcessSyncTransport({
      databaseAdapter: cloud.db,
      clock: cloud.clock,
      objectStorage: cloud.storage,
      syncSharedRecords: true,
      ...(opts.keepLiveOnTombstone ? { keepLiveOnTombstone: opts.keepLiveOnTombstone } : {}),
      ...(opts.reviseIncoming ? { reviseIncoming: opts.reviseIncoming } : {}),
      ...(opts.onApplied ? { onApplied: opts.onApplied } : {}),
    });
    return createSyncEngine({
      localDatabaseAdapter: local.db,
      localObjectStorage: local.storage,
      remoteObjectStorage: cloud.storage,
      transport,
      clock: local.clock,
      syncState: opts.syncState ?? createMemorySyncStateStore(),
      syncSharedRecords: true,
    });
  }

  /** Blobless, so the test is about rows and not transfers. */
  async function put(
    side: Side,
    over: {
      hash: string;
      parentId?: StarkeepId;
      standInRole?: StandInRole;
      fidelity?: number;
      type?: string;
      canonicalThreshold?: number;
      sizeBytes?: number;
    },
  ): Promise<DataRecord> {
    const record = createDataRecord(
      {
        type: over.type ?? "image/avif",
        originAppId: "photos",
        contentHash: over.hash,
        objectStorageKey: "",
        sizeBytes: over.sizeBytes ?? 0,
        parentId: over.parentId ?? null,
        standInRole: over.standInRole ?? null,
        fidelity: over.fidelity ?? null,
        canonicalThreshold: over.canonicalThreshold ?? null,
      },
      side.clock,
    );
    await side.db.put(record);
    return record;
  }

  async function liveIn(side: Side, parentId: StarkeepId, role: StandInRole): Promise<string[]> {
    const result = await side.db.query({
      filters: [
        { field: "parentId", operator: "eq", value: parentId },
        { field: "standInRole", operator: "eq", value: role },
        { field: "deletedAt", operator: "isNull" },
      ],
    });
    return result.records.map((r) => r.id);
  }

  async function withOriginalEverywhere(canonicalThreshold?: number) {
    const s = await sides();
    const stateA = createMemorySyncStateStore();
    const stateB = createMemorySyncStateStore();
    const original = await put(s.a, {
      hash: "sha256:original",
      type: "image/jpeg",
      fidelity: 6000,
      // Above the archive floor, so the original takes a canonical stand-in.
      sizeBytes: 8 * 1024 * 1024,
      ...(canonicalThreshold ? { canonicalThreshold } : {}),
    });
    await engine(s.a, s.cloud, { syncState: stateA }).exchange();
    await engine(s.b, s.cloud, { syncState: stateB }).exchange();
    expect(await s.b.db.get(original.id)).not.toBeNull();
    return { ...s, stateA, stateB, original };
  }

  for (const [role, fidelity] of [
    ["canonical", 4272],
    ["smaller", 640],
  ] as const) {
    it(`keeps the cloud's first ${role} stand-in and tombstones the other everywhere`, async () => {
      const { a, b, cloud, stateA, stateB, original } = await withOriginalEverywhere();
      const fromA = await put(a, { hash: "sha256:encoder-a", parentId: original.id, standInRole: role, fidelity });
      const fromB = await put(b, { hash: "sha256:encoder-b", parentId: original.id, standInRole: role, fidelity });

      await engine(a, cloud, { syncState: stateA }).exchange();
      // B's round carries its stand-in up and the verdict back in one exchange.
      const bRound = await engine(b, cloud, { syncState: stateB }).exchange();
      expect(bRound).toBeTruthy();
      await engine(a, cloud, { syncState: stateA }).exchange();

      for (const side of [a, b, cloud]) {
        expect(await liveIn(side, original.id, role), side.nodeId).toEqual([fromA.id]);
        expect((await side.db.get(fromB.id))?.deletedAt, side.nodeId).toBeTruthy();
      }
    });
  }

  // The original is stamped at 2560: one node made its canonical stand-in under
  // the old 4272, the other made the replacement. Whichever reaches the cloud
  // first, the matching one survives everywhere.
  for (const order of ["outdated first", "matching first"] as const) {
    it(`keeps the canonical stand-in that matches the original's stamp, ${order}`, async () => {
      const { a, b, cloud, stateA, stateB, original } = await withOriginalEverywhere(2560);
      const [first, second] = order === "outdated first" ? [4272, 2560] : [2560, 4272];
      const fromA = await put(a, { hash: "sha256:a", parentId: original.id, standInRole: "canonical", fidelity: first });
      const fromB = await put(b, { hash: "sha256:b", parentId: original.id, standInRole: "canonical", fidelity: second });

      await engine(a, cloud, { syncState: stateA }).exchange();
      await engine(b, cloud, { syncState: stateB }).exchange();
      await engine(a, cloud, { syncState: stateA }).exchange();

      const matching = first === 2560 ? fromA : fromB;
      const outdated = first === 2560 ? fromB : fromA;
      for (const side of [a, b, cloud]) {
        expect(await liveIn(side, original.id, "canonical"), side.nodeId).toEqual([matching.id]);
        expect((await side.db.get(outdated.id))?.deletedAt, side.nodeId).toBeTruthy();
      }
    });
  }

  it("keeps a node's unshipped replacement over an outdated one it pulls", async () => {
    const { a, b, cloud, stateA, stateB, original } = await withOriginalEverywhere(2560);
    const outdated = await put(a, { hash: "sha256:a", parentId: original.id, standInRole: "canonical", fidelity: 4272 });
    await engine(a, cloud, { syncState: stateA }).exchange();
    const replacement = await put(b, { hash: "sha256:b", parentId: original.id, standInRole: "canonical", fidelity: 2560 });
    // B pulls the outdated one before its own push lands anywhere else.
    await engine(b, cloud, { syncState: stateB }).exchange();
    await engine(b, cloud, { syncState: stateB }).exchange();
    await engine(a, cloud, { syncState: stateA }).exchange();
    for (const side of [a, b, cloud]) {
      expect(await liveIn(side, original.id, "canonical"), side.nodeId).toEqual([replacement.id]);
      expect((await side.db.get(outdated.id))?.deletedAt, side.nodeId).toBeTruthy();
    }
  });

  it("converges: later rounds apply and ship nothing", async () => {
    const { a, b, cloud, stateA, stateB, original } = await withOriginalEverywhere();
    await put(a, { hash: "sha256:a", parentId: original.id, standInRole: "canonical", fidelity: 4272 });
    await put(b, { hash: "sha256:b", parentId: original.id, standInRole: "canonical", fidelity: 4272 });
    for (let i = 0; i < 3; i++) {
      await engine(a, cloud, { syncState: stateA }).exchange();
      await engine(b, cloud, { syncState: stateB }).exchange();
    }
    const quietA = await engine(a, cloud, { syncState: stateA }).exchange();
    const quietB = await engine(b, cloud, { syncState: stateB }).exchange();
    expect(quietA.applied).toBe(0);
    expect(quietB.applied).toBe(0);
  });

  it("lets a node that pulls the winner first yield its own stand-in before pushing", async () => {
    const { a, b, cloud, stateA, stateB, original } = await withOriginalEverywhere();
    const fromA = await put(a, { hash: "sha256:a", parentId: original.id, standInRole: "smaller", fidelity: 320 });
    await engine(a, cloud, { syncState: stateA }).exchange();
    const fromB = await put(b, { hash: "sha256:b", parentId: original.id, standInRole: "smaller", fidelity: 320 });
    await engine(b, cloud, { syncState: stateB }).exchange();
    await engine(b, cloud, { syncState: stateB }).exchange();
    expect(await liveIn(b, original.id, "smaller")).toEqual([fromA.id]);
    expect(await liveIn(cloud, original.id, "smaller")).toEqual([fromA.id]);
    expect((await cloud.db.get(fromB.id))?.deletedAt ?? null).not.toBeNull();
  });

  // The cloud's veto of a raised stamp on an archived original rides this hook.
  it("stores the responder's revision of a live row, and ships it back", async () => {
    const { a, cloud, stateA, original } = await withOriginalEverywhere(4272);
    await a.db.put({ ...original, canonicalThreshold: 8192, updatedAt: a.clock.now(), version: original.version + 1 });
    const reviseIncoming = async (current: DataRecord, incoming: DataRecord) =>
      incoming.canonicalThreshold !== current.canonicalThreshold
        ? { ...incoming, canonicalThreshold: current.canonicalThreshold, updatedAt: cloud.clock.now(), version: incoming.version + 1 }
        : null;
    await engine(a, cloud, { syncState: stateA, reviseIncoming }).exchange();
    await engine(a, cloud, { syncState: stateA, reviseIncoming }).exchange();
    expect((await cloud.db.get(original.id))!.canonicalThreshold).toBe(4272);
    expect((await a.db.get(original.id))!.canonicalThreshold).toBe(4272);
  });

  it("keeps a live row the responder refuses to tombstone, and ships it back", async () => {
    const { a, cloud, stateA, original } = await withOriginalEverywhere();
    const canonical = await put(a, {
      hash: "sha256:c",
      parentId: original.id,
      standInRole: "canonical",
      fidelity: 4272,
    });
    await engine(a, cloud, { syncState: stateA }).exchange();
    await a.db.delete(canonical.id, a.clock.now());

    const asked: string[] = [];
    await engine(a, cloud, {
      syncState: stateA,
      keepLiveOnTombstone: async (current) => {
        asked.push(current.id);
        return true;
      },
    }).exchange();
    await engine(a, cloud, { syncState: stateA }).exchange();

    expect(asked).toEqual([canonical.id]);
    expect((await cloud.db.get(canonical.id))?.deletedAt).toBeNull();
    expect((await a.db.get(canonical.id))?.deletedAt).toBeNull();
  });

  it("reports what it applied, once per exchange", async () => {
    const { a, cloud, stateA, original } = await withOriginalEverywhere();
    const small = await put(a, { hash: "sha256:s", parentId: original.id, standInRole: "smaller", fidelity: 640 });
    await a.db.upsertLabels([
      {
        recordId: original.id,
        appId: "photos",
        key: "do-not-archive",
        value: "",
        recordType: "image/jpeg",
        hlc: a.clock.now(),
      },
    ]);
    const calls: Array<{ records: string[]; labels: string[] }> = [];
    await engine(a, cloud, {
      syncState: stateA,
      onApplied: async ({ records, labels }) => {
        calls.push({ records: records.map((r) => r.id), labels: labels.map((l) => l.key) });
      },
    }).exchange();
    expect(calls).toEqual([{ records: [small.id], labels: ["do-not-archive"] }]);
  });
});
