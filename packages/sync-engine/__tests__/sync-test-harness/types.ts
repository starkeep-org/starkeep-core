import type {
  DataRecord,
  HLCClock,
  HLCTimestamp,
  StarkeepId,
} from "@starkeep/core";
import type {
  DatabaseAdapter,
  ObjectStorageAdapter,
} from "@starkeep/storage-adapter";
import type {
  AppSyncableApplier,
  AppSyncableNamespaceStore,
  AppSyncableRowEntry,
  ExchangeResult,
  ScanCapableApplier,
  SyncEngine,
  SyncStateStore,
  Watermarks,
} from "../../src/types.js";
import type { RecordResidency } from "../../src/residency.js";

export type DT = "SR" | "AR" | "AW";

export type Presence =
  | "neither"
  | "local-only"
  | "cloud-only"
  | "both-same"
  | "both-diverged";

export type TombState = "nd" | "cd" | "ld" | "bd" | "bd-diff-ts" | "cdu";

export type BlobState = "nb" | "cb" | "lb" | "bb" | "nh";

export type WmState = "0" | "p" | "cur" | "cR" | "lR";

export type BatchShape =
  | "single"
  | "multi-homogeneous"
  | "multi-mixed-nodes"
  | "exceeds-page-limit";

export interface CaseSpec {
  readonly dt: DT;
  readonly presence: Presence;
  readonly tomb?: TombState;
  readonly blob?: BlobState;
  readonly wm?: WmState;
  readonly batch?: BatchShape;
  readonly batchCount?: number;
  readonly pageLimit?: number;
  readonly appId?: string;
  readonly nodeIds?: { local: string; cloud: string };
}

export type Verb = "insert" | "update" | "soft-delete";

export interface Operation {
  readonly side: "local" | "cloud";
  readonly verb: Verb;
  readonly withBlob?: boolean;
  readonly target?: StarkeepId;
  readonly newContent?: Uint8Array;
}

export type BlobTarget =
  | "all"
  | "first"
  | "middle"
  | "last"
  | { index: number }
  | { id: StarkeepId };

export type FailureSpec =
  | {
      kind: "blob-upload-fails";
      target?: BlobTarget;
      recov: "transient" | "persistent";
    }
  | {
      kind: "blob-download-fails";
      target?: BlobTarget;
      recov: "transient" | "persistent";
    }
  | { kind: "fail-before-request"; recov: "transient" | "persistent" }
  | {
      kind: "fail-after-send-before-response";
      recov: "transient" | "persistent";
    }
  | { kind: "partial-response-truncated"; at?: number };

export interface ExchangeOpts {
  readonly rounds: number | "until-converged";
  readonly inject?: FailureSpec;
}

export interface Side {
  readonly role: "local" | "cloud";
  readonly nodeId: string;
  readonly db: DatabaseAdapter;
  readonly storage: ObjectStorageAdapter;
  readonly applier: AppSyncableApplier & ScanCapableApplier;
  readonly namespaces: AppSyncableNamespaceStore;
  readonly clock: HLCClock;
  /** Direct access to the in-memory app-row store, for assertions. */
  readonly appRows: Map<string, AppSyncableRowEntry>;
}

export interface World {
  readonly spec: ResolvedSpec;
  readonly local: Side;
  readonly cloud: Side;
  readonly engine: SyncEngine;
  readonly syncState: SyncStateStore;

  readonly subjectId: StarkeepId;
  readonly subjectIds: readonly StarkeepId[];

  objectKey(id?: StarkeepId): string;
  hlcOf(id: StarkeepId): HLCTimestamp;

  // Populated for both-diverged
  readonly localHlc?: HLCTimestamp;
  readonly cloudHlc?: HLCTimestamp;
  readonly expectedWinnerHlc?: HLCTimestamp;

  driveOperation(op: Operation): Promise<void>;
  exchange(opts: ExchangeOpts): Promise<ExchangeResult[]>;

  recordExists(side: "local" | "cloud", id?: StarkeepId): Promise<boolean>;
  blobExists(side: "local" | "cloud", key?: string): Promise<boolean>;
  getRecord(
    side: "local" | "cloud",
    id?: StarkeepId,
  ): Promise<DataRecord | null>;
  getAppRow(
    side: "local" | "cloud",
    id?: StarkeepId,
  ): Promise<AppSyncableRowEntry | null>;
  residency(
    side: "local" | "cloud",
    id?: StarkeepId,
  ): Promise<RecordResidency>;
  watermarks(): Promise<{ own: Watermarks; peer: Watermarks }>;
}

/** Spec with all defaults resolved. */
export interface ResolvedSpec {
  readonly dt: DT;
  readonly presence: Presence;
  readonly tomb: TombState;
  readonly blob: BlobState;
  readonly wm: WmState;
  readonly batch: BatchShape;
  readonly batchCount: number;
  readonly pageLimit: number;
  readonly appId: string;
  readonly nodeIds: { local: string; cloud: string };
}
