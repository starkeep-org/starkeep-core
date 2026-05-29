import { compareHLC, type HLCTimestamp, type StarkeepId } from "@starkeep/core";
import { createSyncEngine } from "../../src/sync-engine.js";
import { createInProcessSyncTransport } from "../../src/transports/in-process-transport.js";
import { residencyOf, type RecordResidency } from "../../src/residency.js";
import type {
  ExchangeResult,
  SyncStateStore,
  Watermarks,
} from "../../src/types.js";
import {
  buildKeyMatcher,
  FailingObjectStorageAdapter,
} from "./failure-injection.js";
import { buildSide } from "./side.js";
import {
  applyWatermarkState,
  seedInitialState,
} from "./seeding.js";
import { driveOperation } from "./operations.js";
import type {
  BlobTarget,
  CaseSpec,
  ExchangeOpts,
  FailureSpec,
  ResolvedSpec,
  Side,
  World,
} from "./types.js";

function resolveSpec(spec: CaseSpec): ResolvedSpec {
  const dt = spec.dt;
  const presence = spec.presence;
  const tomb = spec.tomb ?? "nd";
  const batch = spec.batch ?? "single";

  let blob = spec.blob;
  if (!blob) {
    if (dt === "AW") blob = "nb";
    else if (presence === "neither") blob = "nb";
    else if (presence === "local-only") blob = "lb";
    else if (presence === "cloud-only") blob = "cb";
    else blob = "bb";
  }
  if (dt === "AW" && blob !== "nb") {
    throw new Error(`[harness] AW data type forbids blob=${blob}`);
  }

  let batchCount = spec.batchCount;
  if (batchCount === undefined) {
    if (batch === "single") batchCount = 1;
    else if (batch === "exceeds-page-limit") batchCount = 6;
    else batchCount = 3;
  }

  return {
    dt,
    presence,
    tomb,
    blob,
    wm: spec.wm ?? "p",
    batch,
    batchCount,
    pageLimit: spec.pageLimit ?? (batch === "exceeds-page-limit" ? 5 : 1000),
    appId: spec.appId ?? "test-app",
    nodeIds: spec.nodeIds ?? { local: "local", cloud: "cloud" },
  };
}

function makeSyncState(): SyncStateStore {
  let watermarks: Watermarks = {};
  let peerWatermarks: Watermarks = {};
  return {
    async getWatermarks() {
      return watermarks;
    },
    async setWatermarks(w) {
      watermarks = w;
    },
    async getPeerWatermarks() {
      return peerWatermarks;
    },
    async setPeerWatermarks(w) {
      peerWatermarks = w;
    },
    async getHlcClockState() {
      return null;
    },
    async setHlcClockState() {},
  };
}

export async function setupCase(spec: CaseSpec): Promise<World> {
  const resolved = resolveSpec(spec);

  // Shared wallclock so HLCs from both sides are deterministically ordered.
  let sharedTime = 1000;
  const wallClock = () => sharedTime++;

  const local = await buildSide({
    role: "local",
    nodeId: resolved.nodeIds.local,
    wallClock,
    appId: resolved.appId,
  });
  const cloud = await buildSide({
    role: "cloud",
    nodeId: resolved.nodeIds.cloud,
    wallClock,
    appId: resolved.appId,
  });

  const seeded = await seedInitialState(local, cloud, resolved);
  const syncState = makeSyncState();
  await applyWatermarkState(syncState, seeded, resolved, local, cloud);

  const cloudTransport = createInProcessSyncTransport({
    databaseAdapter: cloud.db,
    clock: cloud.clock,
    objectStorage: cloud.storage,
    appSyncableSource: {
      namespaces: cloud.namespaces,
      applier: cloud.applier,
    },
  });
  const engine = createSyncEngine({
    localDatabaseAdapter: local.db,
    localObjectStorage: local.storage,
    remoteObjectStorage: cloud.storage,
    transport: cloudTransport,
    clock: local.clock,
    syncState,
    appSyncableSource: {
      namespaces: local.namespaces,
      // FileRecordsApplier face isn't exercised by exchange() today; cast
      // through unknown for the test mock which only implements scan/apply.
      applier: local.applier as never,
    },
    pageLimit: resolved.pageLimit,
  });

  const subjectIds: StarkeepId[] = [...seeded.subjectIds];
  const objectKeyById = new Map<StarkeepId, string>(seeded.objectKeyById);
  const hlcByLocal = new Map<StarkeepId, HLCTimestamp>(seeded.hlcByLocal);
  const hlcByCloud = new Map<StarkeepId, HLCTimestamp>(seeded.hlcByCloud);

  function objectKey(id?: StarkeepId): string {
    const target = id ?? subjectIds[0];
    if (!target) throw new Error("[harness] no subject id available");
    const k = objectKeyById.get(target);
    if (!k)
      throw new Error(`[harness] no object key tracked for ${target}`);
    return k;
  }

  function hlcOf(id: StarkeepId): HLCTimestamp {
    return (
      hlcByLocal.get(id) ??
      hlcByCloud.get(id) ??
      (() => {
        throw new Error(`[harness] no HLC tracked for ${id}`);
      })()
    );
  }

  function side(role: "local" | "cloud"): Side {
    return role === "local" ? local : cloud;
  }

  async function recordExists(
    role: "local" | "cloud",
    id?: StarkeepId,
  ): Promise<boolean> {
    const r = await side(role).db.get(id ?? subjectIds[0]!);
    return r !== null;
  }

  async function blobExists(
    role: "local" | "cloud",
    key?: string,
  ): Promise<boolean> {
    return side(role).storage.has(key ?? objectKey());
  }

  async function getRecord(role: "local" | "cloud", id?: StarkeepId) {
    return side(role).db.get(id ?? subjectIds[0]!);
  }

  async function getAppRow(
    _role: "local" | "cloud",
    _id?: StarkeepId,
  ): ReturnType<World["getAppRow"]> {
    // AR/AW assertion path not implemented yet — single-row lookup needs the
    // spec's appId + table to disambiguate; surface a clear error rather than
    // silently returning null until tests need it.
    throw new Error("[harness] getAppRow not implemented yet (AR/AW pending)");
  }

  async function residency(
    role: "local" | "cloud",
    id?: StarkeepId,
  ): Promise<RecordResidency> {
    const target = id ?? subjectIds[0];
    if (!target) throw new Error("[harness] no subject id for residency");
    const rec = await side(role).db.get(target);
    if (!rec) return "absent";
    // Reshape SR DataRecord into the FileRecordRow snake_case form residencyOf
    // expects.
    return residencyOf(
      {
        id: rec.id,
        object_storage_key: rec.objectStorageKey,
        content_hash: rec.contentHash,
        mime_type: rec.mimeType,
        size_bytes: rec.sizeBytes,
        original_filename: rec.originalFilename ?? null,
        origin_app_id: rec.originAppId,
        created_at: "",
        updated_at: "",
        deleted_at: rec.deletedAt ? "deleted" : null,
      },
      side(role).storage,
    );
  }

  async function watermarks(): Promise<{ own: Watermarks; peer: Watermarks }> {
    return {
      own: await syncState.getWatermarks(),
      peer: await syncState.getPeerWatermarks(),
    };
  }

  async function applyInjection(inject: FailureSpec): Promise<void> {
    if (
      inject.kind === "fail-before-request" ||
      inject.kind === "fail-after-send-before-response" ||
      inject.kind === "partial-response-truncated"
    ) {
      throw new Error(
        `[harness] failure mode ${inject.kind} not implemented yet`,
      );
    }

    const candidateKeys = subjectIds.map((id) => {
      const k = objectKeyById.get(id);
      if (!k)
        throw new Error(`[harness] no object key for subject ${id}`);
      return k;
    });

    const target: BlobTarget = inject.target ?? "all";
    const matcher = buildKeyMatcher(
      target,
      candidateKeys,
      (id) => objectKeyById.get(id as StarkeepId),
    );

    // Outbound blob upload happens against remote.storage; inbound download
    // happens against local.storage. The failing wrapper sits on `put`.
    const storage =
      inject.kind === "blob-upload-fails" ? cloud.storage : local.storage;
    if (!(storage instanceof FailingObjectStorageAdapter)) {
      throw new Error(
        "[harness] expected FailingObjectStorageAdapter on injected side",
      );
    }
    storage.installRule({
      matches: matcher,
      recov: inject.recov,
      label: inject.kind,
    });
  }

  async function exchange(opts: ExchangeOpts): Promise<ExchangeResult[]> {
    if (opts.inject) await applyInjection(opts.inject);

    const results: ExchangeResult[] = [];
    const cap = 100;
    if (opts.rounds === "until-converged") {
      let i = 0;
      while (i < cap) {
        const r = await engine.exchange();
        results.push(r);
        if (!r.hasMore && r.applied === 0 && r.shipped === 0) break;
        i++;
      }
      if (i === cap) {
        throw new Error(
          "[harness] until-converged hit 100-round cap — likely divergence bug",
        );
      }
    } else {
      for (let i = 0; i < opts.rounds; i++) {
        results.push(await engine.exchange());
      }
    }
    return results;
  }

  const world: World = {
    spec: resolved,
    local,
    cloud,
    engine,
    syncState,
    // Tracks the first id; for `presence: "neither"` cases this is undefined
    // until `driveOperation({ verb: "insert" })` runs. Tests that read it
    // pre-insert in a "neither" case will see undefined — by design.
    get subjectId() {
      return subjectIds[0] as StarkeepId;
    },
    subjectIds,
    objectKey,
    hlcOf,
    localHlc: seeded.localHlc,
    cloudHlc: seeded.cloudHlc,
    expectedWinnerHlc: seeded.expectedWinnerHlc,
    async driveOperation(op) {
      const ctx = {
        objectKeyById,
        subjectIds,
      };
      const result = await driveOperation(op, resolved, local, cloud, ctx);
      if (result.insertedId) {
        // First insert in a "neither" case becomes the subject; later inserts
        // append to subjectIds without disturbing index 0.
        if (subjectIds.length === 1 && subjectIds[0] === result.insertedId) {
          // Already first; nothing to do.
        }
        const newHlc = (await side(op.side).db.get(result.insertedId))!
          .updatedAt;
        if (op.side === "local") hlcByLocal.set(result.insertedId, newHlc);
        else hlcByCloud.set(result.insertedId, newHlc);
      }
    },
    exchange,
    recordExists,
    blobExists,
    getRecord,
    getAppRow,
    residency,
    watermarks,
  };

  // Mutate subjectId on the returned world *after* the first insert ever
  // happens, so it always reflects the canonical subject. Because the World's
  // shape is readonly, we publish via a getter — but to keep the interface
  // simple we just publish what was seeded and document insert-only-rewrites
  // happen via `subjectIds.push`.
  void compareHLC;
  return world;
}
