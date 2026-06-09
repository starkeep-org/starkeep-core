import {
  compareHLC,
  createDataRecord,
  generateId,
  serializeHLC,
  ZERO_HLC,
  type DataRecord,
  type HLCTimestamp,
  type StarkeepId,
} from "@starkeep/protocol-primitives";
import {
  advanceWatermark,
} from "../../src/watermarks.js";
import type {
  AppSyncableRowEntry,
  SyncStateStore,
  Watermarks,
} from "../../src/types.js";
import { FILE_RECORDS_TABLE } from "./mock-app-source.js";
import type { ResolvedSpec, Side } from "./types.js";

export interface SeededState {
  readonly subjectIds: StarkeepId[];
  readonly hlcByLocal: Map<StarkeepId, HLCTimestamp>;
  readonly hlcByCloud: Map<StarkeepId, HLCTimestamp>;
  readonly objectKeyById: Map<StarkeepId, string>;
  readonly localHlc?: HLCTimestamp;
  readonly cloudHlc?: HLCTimestamp;
  readonly expectedWinnerHlc?: HLCTimestamp;
}

const BLOB_BYTES = new Uint8Array([1, 2, 3]);
const ALT_BLOB_BYTES = new Uint8Array([4, 5, 6]);

/**
 * Seed initial state per `spec.presence` × `spec.blob` × `spec.tomb`. Returns
 * tracking info that `setupCase` exposes on the World.
 *
 * Single-record only for now; multi-record batches and AR/AW seeding will be
 * added as their candidate cohorts come into scope.
 */
export async function seedInitialState(
  local: Side,
  cloud: Side,
  spec: ResolvedSpec,
): Promise<SeededState> {
  if (spec.batch === "single") {
    if (spec.dt === "SR") return seedSrSingle(local, cloud, spec);
    if (spec.dt === "AR") return seedArSingle(local, cloud, spec);
    return seedAwSingle(local, cloud, spec);
  }
  // Multi-record variants — SR only for now.
  if (spec.dt !== "SR") {
    throw new Error(
      `[harness] multi-record seeding for dt=${spec.dt} not implemented yet`,
    );
  }
  return seedSrMulti(local, cloud, spec);
}

async function seedSrSingle(
  local: Side,
  cloud: Side,
  spec: ResolvedSpec,
): Promise<SeededState> {
  const id = generateId() as StarkeepId;
  const objectKey = `shared/test/photo/${id}`;
  const baseInput = {
    type: "@test/photo",
    originAppId: "test",
    contentHash: "sha256:base",
    objectStorageKey: objectKey,
    mimeType: "image/jpeg",
    sizeBytes: 100,
  } as const;

  const hlcByLocal = new Map<StarkeepId, HLCTimestamp>();
  const hlcByCloud = new Map<StarkeepId, HLCTimestamp>();
  let localHlc: HLCTimestamp | undefined;
  let cloudHlc: HLCTimestamp | undefined;
  let winnerHlc: HLCTimestamp | undefined;

  switch (spec.presence) {
    case "neither":
      break;

    case "local-only": {
      const r = recordWithId(createDataRecord(baseInput, local.clock), id);
      await local.db.put(r);
      localHlc = r.updatedAt;
      hlcByLocal.set(id, r.updatedAt);
      break;
    }

    case "cloud-only": {
      const r = recordWithId(createDataRecord(baseInput, cloud.clock), id);
      await cloud.db.put(r);
      cloudHlc = r.updatedAt;
      hlcByCloud.set(id, r.updatedAt);
      break;
    }

    case "both-same": {
      const r = recordWithId(createDataRecord(baseInput, local.clock), id);
      await local.db.put(r);
      // Cloud receives an identical copy — keep clocks causally aware.
      cloud.clock.receive(r.updatedAt);
      await cloud.db.put(r);
      localHlc = cloudHlc = r.updatedAt;
      hlcByLocal.set(id, r.updatedAt);
      hlcByCloud.set(id, r.updatedAt);
      break;
    }

    case "both-diverged": {
      // Local writes first at T₁.
      const rLocal = recordWithId(createDataRecord(baseInput, local.clock), id);
      await local.db.put(rLocal);
      localHlc = rLocal.updatedAt;
      hlcByLocal.set(id, rLocal.updatedAt);

      // Cloud writes at T₂ > T₁ with different content.
      const rCloud = recordWithId(
        createDataRecord(
          { ...baseInput, contentHash: "sha256:cloud" },
          cloud.clock,
        ),
        id,
      );
      await cloud.db.put(rCloud);
      cloudHlc = rCloud.updatedAt;
      hlcByCloud.set(id, rCloud.updatedAt);
      winnerHlc =
        compareHLC(rCloud.updatedAt, rLocal.updatedAt) > 0
          ? rCloud.updatedAt
          : rLocal.updatedAt;
      break;
    }
  }

  await applyBlobState(local, cloud, objectKey, spec);
  await applyTombState(local, cloud, id, spec, hlcByLocal, hlcByCloud);

  // For `presence: "neither"` no record was actually created — return empty
  // tracking so a subsequent `driveOperation({ verb: "insert" })` populates
  // subjectIds with the real new id.
  if (spec.presence === "neither") {
    return {
      subjectIds: [],
      hlcByLocal,
      hlcByCloud,
      objectKeyById: new Map(),
      localHlc,
      cloudHlc,
      expectedWinnerHlc: winnerHlc,
    };
  }

  return {
    subjectIds: [id],
    hlcByLocal,
    hlcByCloud,
    objectKeyById: new Map([[id, objectKey]]),
    localHlc,
    cloudHlc,
    expectedWinnerHlc: winnerHlc,
  };
}

function recordWithId(record: DataRecord, id: StarkeepId): DataRecord {
  return { ...record, id };
}

/**
 * Multi-record SR seeding.
 *
 * - `multi-homogeneous`: all records share one originating nodeId (local by
 *   default; cloud if presence is cloud-only).
 * - `multi-mixed-nodes`: records alternate originating nodeId (local, cloud,
 *   local, cloud, …) but are stored on whichever side `presence` says.
 * - `exceeds-page-limit`: same as multi-homogeneous; the test pairs this
 *   with a small `pageLimit` so pagination kicks in.
 *
 * Tomb states (`bd`, etc.) and `cdu` aren't applied here — the multi-record
 * candidates that need them haven't surfaced yet; revisit when they do.
 */
async function seedSrMulti(
  local: Side,
  cloud: Side,
  spec: ResolvedSpec,
): Promise<SeededState> {
  const subjectIds: StarkeepId[] = [];
  const objectKeyById = new Map<StarkeepId, string>();
  const hlcByLocal = new Map<StarkeepId, HLCTimestamp>();
  const hlcByCloud = new Map<StarkeepId, HLCTimestamp>();

  if (spec.presence === "neither") {
    return {
      subjectIds: [],
      hlcByLocal,
      hlcByCloud,
      objectKeyById,
    };
  }
  if (spec.presence === "both-diverged") {
    throw new Error(
      "[harness] multi-record + both-diverged not implemented (no candidates need it)",
    );
  }

  const onLocal =
    spec.presence === "local-only" || spec.presence === "both-same";
  const onCloud =
    spec.presence === "cloud-only" || spec.presence === "both-same";

  function originatingSideFor(i: number): Side {
    if (spec.batch === "multi-mixed-nodes") {
      return i % 2 === 0 ? local : cloud;
    }
    if (onLocal && !onCloud) return local;
    if (onCloud && !onLocal) return cloud;
    // both-same homogeneous — pick local as the canonical origin.
    return local;
  }

  for (let i = 0; i < spec.batchCount; i++) {
    const id = generateId() as StarkeepId;
    const objectKey = `shared/test/multi/${id}`;
    const origin = originatingSideFor(i);
    const record = recordWithId(
      createDataRecord(
        {
          type: "@test/photo",
          originAppId: "test",
          contentHash: `sha256:multi-${i}`,
          objectStorageKey: objectKey,
          mimeType: "image/jpeg",
          sizeBytes: 100,
        },
        origin.clock,
      ),
      id,
    );

    if (onLocal) {
      await local.db.put(record);
      hlcByLocal.set(id, record.updatedAt);
      if (spec.blob === "lb" || spec.blob === "bb") {
        await local.storage.put(objectKey, BLOB_BYTES, {
          contentType: "image/jpeg",
        });
      }
    }
    if (onCloud) {
      // For both-same: keep the cloud-side clock causally aware, then put
      // the identical record (same updatedAt).
      cloud.clock.receive(record.updatedAt);
      await cloud.db.put(record);
      hlcByCloud.set(id, record.updatedAt);
      if (spec.blob === "cb" || spec.blob === "bb") {
        await cloud.storage.put(objectKey, BLOB_BYTES, {
          contentType: "image/jpeg",
        });
      }
    }

    subjectIds.push(id);
    objectKeyById.set(id, objectKey);
  }

  return {
    subjectIds,
    hlcByLocal,
    hlcByCloud,
    objectKeyById,
  };
}

function arRow(
  id: string,
  key: string,
  contentHash: string,
  hlc: HLCTimestamp,
  appId: string,
): Record<string, unknown> {
  const hlcStr = serializeHLC(hlc);
  return {
    id,
    object_storage_key: key,
    content_hash: contentHash,
    mime_type: "image/jpeg",
    size_bytes: 100,
    original_filename: null,
    origin_app_id: appId,
    created_at: hlcStr,
    updated_at: hlcStr,
    deleted_at: null,
  };
}

async function seedArSingle(
  local: Side,
  cloud: Side,
  spec: ResolvedSpec,
): Promise<SeededState> {
  const id = generateId() as StarkeepId;
  // For blob=nb, store an empty object_storage_key so manifestForAppRow
  // returns null and the engine ships the metadata without a blob attempt
  // (the "metadata-only app record" pattern).
  const objectKey = spec.blob === "nb" ? "" : `app/${spec.appId}/${id}`;
  const hlcByLocal = new Map<StarkeepId, HLCTimestamp>();
  const hlcByCloud = new Map<StarkeepId, HLCTimestamp>();
  let localHlc: HLCTimestamp | undefined;
  let cloudHlc: HLCTimestamp | undefined;
  let winnerHlc: HLCTimestamp | undefined;

  async function applyAr(
    side: Side,
    hlc: HLCTimestamp,
    contentHash: string,
  ): Promise<void> {
    const entry: AppSyncableRowEntry = {
      timestamp: hlc,
      appId: spec.appId,
      table: FILE_RECORDS_TABLE,
      op: "insert",
      row: arRow(id, objectKey, contentHash, hlc, spec.appId),
    };
    await side.applier.apply(entry);
  }

  switch (spec.presence) {
    case "neither":
      break;
    case "local-only": {
      const hlc = local.clock.now();
      await applyAr(local, hlc, "sha256:base");
      localHlc = hlc;
      hlcByLocal.set(id, hlc);
      break;
    }
    case "cloud-only": {
      const hlc = cloud.clock.now();
      await applyAr(cloud, hlc, "sha256:base");
      cloudHlc = hlc;
      hlcByCloud.set(id, hlc);
      break;
    }
    case "both-same": {
      const hlc = local.clock.now();
      await applyAr(local, hlc, "sha256:base");
      cloud.clock.receive(hlc);
      await applyAr(cloud, hlc, "sha256:base");
      localHlc = cloudHlc = hlc;
      hlcByLocal.set(id, hlc);
      hlcByCloud.set(id, hlc);
      break;
    }
    case "both-diverged": {
      const t1 = local.clock.now();
      await applyAr(local, t1, "sha256:base");
      hlcByLocal.set(id, t1);
      localHlc = t1;
      const t2 = cloud.clock.now();
      await applyAr(cloud, t2, "sha256:cloud");
      hlcByCloud.set(id, t2);
      cloudHlc = t2;
      winnerHlc = compareHLC(t2, t1) > 0 ? t2 : t1;
      break;
    }
  }

  await applyArBlobState(local, cloud, objectKey, spec);
  await applyArTombState(local, cloud, id, spec, hlcByLocal, hlcByCloud);

  if (spec.presence === "neither") {
    return {
      subjectIds: [],
      hlcByLocal,
      hlcByCloud,
      objectKeyById: new Map(),
      localHlc,
      cloudHlc,
      expectedWinnerHlc: winnerHlc,
    };
  }

  return {
    subjectIds: [id],
    hlcByLocal,
    hlcByCloud,
    objectKeyById: new Map([[id, objectKey]]),
    localHlc,
    cloudHlc,
    expectedWinnerHlc: winnerHlc,
  };
}

async function applyArBlobState(
  local: Side,
  cloud: Side,
  objectKey: string,
  spec: ResolvedSpec,
): Promise<void> {
  const blob = spec.blob;
  if (blob === "nb" || blob === "nh") return;

  const hasLocal =
    spec.presence === "local-only" ||
    spec.presence === "both-same" ||
    spec.presence === "both-diverged";
  const hasCloud =
    spec.presence === "cloud-only" ||
    spec.presence === "both-same" ||
    spec.presence === "both-diverged";

  if ((blob === "lb" || blob === "bb") && hasLocal) {
    await local.storage.put(objectKey, BLOB_BYTES, {
      contentType: "image/jpeg",
    });
  }
  if ((blob === "cb" || blob === "bb") && hasCloud) {
    await cloud.storage.put(
      objectKey,
      spec.presence === "both-diverged" ? ALT_BLOB_BYTES : BLOB_BYTES,
      { contentType: "image/jpeg" },
    );
  }
}

async function applyArTombState(
  local: Side,
  cloud: Side,
  id: StarkeepId,
  spec: ResolvedSpec,
  hlcByLocal: Map<StarkeepId, HLCTimestamp>,
  hlcByCloud: Map<StarkeepId, HLCTimestamp>,
): Promise<void> {
  const tomb = spec.tomb;
  if (tomb === "nd") return;

  const objectKey =
    spec.blob === "nb" ? "" : `app/${spec.appId}/${id}`;

  async function tombstoneAr(side: Side, hlc: HLCTimestamp): Promise<void> {
    const hlcStr = serializeHLC(hlc);
    const entry: AppSyncableRowEntry = {
      timestamp: hlc,
      appId: spec.appId,
      table: FILE_RECORDS_TABLE,
      op: "delete",
      row: {
        ...arRow(id, objectKey, "sha256:tombstone", hlc, spec.appId),
        updated_at: hlcStr,
        deleted_at: hlcStr,
      },
    };
    await side.applier.apply(entry);
  }

  if (tomb === "cd" || tomb === "bd" || tomb === "bd-diff-ts") {
    const hlc = cloud.clock.now();
    await tombstoneAr(cloud, hlc);
    hlcByCloud.set(id, hlc);
  }
  if (tomb === "ld" || tomb === "bd" || tomb === "bd-diff-ts") {
    const hlc = local.clock.now();
    await tombstoneAr(local, hlc);
    hlcByLocal.set(id, hlc);
  }
  if (tomb === "cdu") {
    const tHlc = cloud.clock.now();
    await tombstoneAr(cloud, tHlc);
    hlcByCloud.set(id, tHlc);
    const uHlc = local.clock.now();
    await local.applier.apply({
      timestamp: uHlc,
      appId: spec.appId,
      table: FILE_RECORDS_TABLE,
      op: "insert",
      row: arRow(id, objectKey, "sha256:local-updated", uHlc, spec.appId),
    });
    hlcByLocal.set(id, uHlc);
  }
}

async function seedAwSingle(
  local: Side,
  cloud: Side,
  spec: ResolvedSpec,
): Promise<SeededState> {
  const id = generateId() as StarkeepId;
  const hlcByLocal = new Map<StarkeepId, HLCTimestamp>();
  const hlcByCloud = new Map<StarkeepId, HLCTimestamp>();
  let localHlc: HLCTimestamp | undefined;
  let cloudHlc: HLCTimestamp | undefined;
  let winnerHlc: HLCTimestamp | undefined;

  function awRow(hlc: HLCTimestamp, payload: string): Record<string, unknown> {
    const hlcStr = serializeHLC(hlc);
    return {
      id,
      payload,
      created_at: hlcStr,
      updated_at: hlcStr,
      deleted_at: null,
    };
  }

  async function applyAw(side: Side, hlc: HLCTimestamp, payload: string) {
    await side.applier.apply({
      timestamp: hlc,
      appId: spec.appId,
      table: "test_rows",
      op: "insert",
      row: awRow(hlc, payload),
    });
  }

  switch (spec.presence) {
    case "neither":
      break;
    case "local-only": {
      const hlc = local.clock.now();
      await applyAw(local, hlc, "base");
      localHlc = hlc;
      hlcByLocal.set(id, hlc);
      break;
    }
    case "cloud-only": {
      const hlc = cloud.clock.now();
      await applyAw(cloud, hlc, "base");
      cloudHlc = hlc;
      hlcByCloud.set(id, hlc);
      break;
    }
    case "both-same": {
      const hlc = local.clock.now();
      await applyAw(local, hlc, "base");
      cloud.clock.receive(hlc);
      await applyAw(cloud, hlc, "base");
      localHlc = cloudHlc = hlc;
      hlcByLocal.set(id, hlc);
      hlcByCloud.set(id, hlc);
      break;
    }
    case "both-diverged": {
      const t1 = local.clock.now();
      await applyAw(local, t1, "base-local");
      hlcByLocal.set(id, t1);
      localHlc = t1;
      const t2 = cloud.clock.now();
      await applyAw(cloud, t2, "base-cloud");
      hlcByCloud.set(id, t2);
      cloudHlc = t2;
      winnerHlc = compareHLC(t2, t1) > 0 ? t2 : t1;
      break;
    }
  }

  await applyAwTombState(local, cloud, id, spec, hlcByLocal, hlcByCloud);

  if (spec.presence === "neither") {
    return {
      subjectIds: [],
      hlcByLocal,
      hlcByCloud,
      objectKeyById: new Map(),
      localHlc,
      cloudHlc,
      expectedWinnerHlc: winnerHlc,
    };
  }

  return {
    subjectIds: [id],
    hlcByLocal,
    hlcByCloud,
    objectKeyById: new Map(),
    localHlc,
    cloudHlc,
    expectedWinnerHlc: winnerHlc,
  };
}

async function applyAwTombState(
  local: Side,
  cloud: Side,
  id: StarkeepId,
  spec: ResolvedSpec,
  hlcByLocal: Map<StarkeepId, HLCTimestamp>,
  hlcByCloud: Map<StarkeepId, HLCTimestamp>,
): Promise<void> {
  const tomb = spec.tomb;
  if (tomb === "nd") return;

  async function tombstoneAw(side: Side, hlc: HLCTimestamp): Promise<void> {
    const hlcStr = serializeHLC(hlc);
    await side.applier.apply({
      timestamp: hlc,
      appId: spec.appId,
      table: "test_rows",
      op: "delete",
      row: {
        id,
        payload: "tombstone",
        updated_at: hlcStr,
        deleted_at: hlcStr,
      },
    });
  }

  if (tomb === "cd" || tomb === "bd" || tomb === "bd-diff-ts") {
    const hlc = cloud.clock.now();
    await tombstoneAw(cloud, hlc);
    hlcByCloud.set(id, hlc);
  }
  if (tomb === "ld" || tomb === "bd" || tomb === "bd-diff-ts") {
    const hlc = local.clock.now();
    await tombstoneAw(local, hlc);
    hlcByLocal.set(id, hlc);
  }
  if (tomb === "cdu") {
    const tHlc = cloud.clock.now();
    await tombstoneAw(cloud, tHlc);
    hlcByCloud.set(id, tHlc);
    const uHlc = local.clock.now();
    const hlcStr = serializeHLC(uHlc);
    await local.applier.apply({
      timestamp: uHlc,
      appId: spec.appId,
      table: "test_rows",
      op: "insert",
      row: {
        id,
        payload: "local-updated",
        updated_at: hlcStr,
        deleted_at: null,
      },
    });
    hlcByLocal.set(id, uHlc);
  }
}

async function applyBlobState(
  local: Side,
  cloud: Side,
  objectKey: string,
  spec: ResolvedSpec,
): Promise<void> {
  // For DT=SR the default is bb when both sides hold the record; mirror
  // presence for one-sided cases; nh is "neither, both staged".
  const blob = spec.blob;
  if (blob === "nb" || blob === "nh") return;

  const hasLocalRecord =
    spec.presence === "local-only" ||
    spec.presence === "both-same" ||
    spec.presence === "both-diverged";
  const hasCloudRecord =
    spec.presence === "cloud-only" ||
    spec.presence === "both-same" ||
    spec.presence === "both-diverged";

  if ((blob === "lb" || blob === "bb") && hasLocalRecord) {
    await local.storage.put(objectKey, BLOB_BYTES, {
      contentType: "image/jpeg",
    });
  }
  if ((blob === "cb" || blob === "bb") && hasCloudRecord) {
    await cloud.storage.put(
      objectKey,
      spec.presence === "both-diverged" ? ALT_BLOB_BYTES : BLOB_BYTES,
      { contentType: "image/jpeg" },
    );
  }
}

async function applyTombState(
  local: Side,
  cloud: Side,
  id: StarkeepId,
  spec: ResolvedSpec,
  hlcByLocal: Map<StarkeepId, HLCTimestamp>,
  hlcByCloud: Map<StarkeepId, HLCTimestamp>,
): Promise<void> {
  const tomb = spec.tomb;
  if (tomb === "nd") return;

  if (tomb === "cd" || tomb === "bd" || tomb === "bd-diff-ts") {
    const hlc = cloud.clock.now();
    await cloud.db.delete(id, hlc);
    hlcByCloud.set(id, hlc);
  }
  if (tomb === "ld" || tomb === "bd" || tomb === "bd-diff-ts") {
    const hlc = local.clock.now();
    await local.db.delete(id, hlc);
    hlcByLocal.set(id, hlc);
  }
  if (tomb === "cdu") {
    // "Conflict-deleted-vs-updated": cloud deletes, then local updates with a
    // strictly later HLC. The harness models the *state* here; the test asserts
    // LWW resolves to the local update (the larger HLC) on exchange.
    const tHlc = cloud.clock.now();
    await cloud.db.delete(id, tHlc);
    hlcByCloud.set(id, tHlc);

    const existing = await local.db.get(id);
    if (existing) {
      const updated: DataRecord = {
        ...existing,
        updatedAt: local.clock.now(),
        contentHash: "sha256:local-updated",
      };
      await local.db.put(updated);
      hlcByLocal.set(id, updated.updatedAt);
    }
  }
}

export async function applyWatermarkState(
  syncState: SyncStateStore,
  seeded: SeededState,
  spec: ResolvedSpec,
  local: Side,
  cloud: Side,
): Promise<void> {
  // `ownWatermarks` on the local side tracks records local has applied
  // (received from peer or originated locally). `peerWatermarks` tracks
  // records local has successfully shipped to the peer. Each side's
  // watermark map should only include HLCs corresponding to records that
  // *both* sides hold — otherwise we'd claim sync history that didn't
  // happen, and the engine would skip records the test expects to ship.
  const ownAtMax: Watermarks = {};
  const peerAtMax: Watermarks = {};
  for (const [, hlc] of seeded.hlcByLocal) advanceWatermark(ownAtMax, hlc);
  for (const [id, hlc] of seeded.hlcByCloud) {
    // The peer (cloud) has this record. If local also has it (both-same /
    // both-diverged), then local has successfully had this record shipped
    // to it (or vice-versa), so it counts toward both maps. If only cloud
    // has it, only the cloud-side has it — no peerWatermark entry needed.
    if (seeded.hlcByLocal.has(id)) advanceWatermark(peerAtMax, hlc);
    if (seeded.hlcByLocal.has(id)) advanceWatermark(ownAtMax, hlc);
  }
  // Records originated on local that are also on cloud → in peerWatermarks.
  for (const [id, hlc] of seeded.hlcByLocal) {
    if (seeded.hlcByCloud.has(id)) advanceWatermark(peerAtMax, hlc);
  }

  switch (spec.wm) {
    case "0":
    case "p":
      // Empty on both sides — engine sees all seeded HLCs as new. Single-record
      // seeds don't meaningfully distinguish `p` from `0`; the difference
      // becomes observable only with multi-record state.
      await syncState.setWatermarks({});
      await syncState.setPeerWatermarks({});
      break;

    case "cur":
      // Fully converged: both maps reflect everything both sides hold. Only
      // coherent with `both-same`; for other presence values the harness
      // still produces *something* but the resulting state may not be a
      // valid "current" snapshot.
      await syncState.setWatermarks(ownAtMax);
      await syncState.setPeerWatermarks(peerAtMax);
      break;

    case "lR":
      // Local SQLite wipe / new device: both own and peer watermarks are
      // gone (they live in local SQLite). Data preservation here is
      // hypothetical — modeled to exercise "data present, no bookkeeping."
      await syncState.setWatermarks({});
      await syncState.setPeerWatermarks({});
      break;

    case "cR":
      // Models "cloud forgot what local sent": peerWatermarks wiped, so
      // local re-ships everything it had successfully shipped before.
      // ownWatermarks preserved at what local actually has.
      await syncState.setWatermarks(ownAtMax);
      await syncState.setPeerWatermarks({});
      break;
  }

  // Silence unused-var warnings until multi-record seeding consumes these.
  void serializeHLC;
  void ZERO_HLC;
  void local;
  void cloud;
}
