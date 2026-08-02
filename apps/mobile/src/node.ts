/**
 * Assembling the phone as a sync peer (item 12).
 *
 * ## What this is, and what it deliberately is not
 *
 * This wires the existing engine to the phone's adapters and nothing more.
 * There is no phone-specific sync logic here, and there should never be: the
 * exchange, the watermarks, the residency decision and the transfer rules are
 * the same on every node, and a second implementation "for mobile" is how two
 * nodes come to disagree about what they have.
 *
 * The phone differs in three ways, all of them *configuration*:
 *
 * 1. **It is not the cloud node.** `starkeep/no-cloud` forbids the cloud and
 *    says nothing about a handset, so `isCloudNode` is false and such records
 *    are held freely — reading the constraint as "nobody may hold this" would
 *    turn a privacy preference into data loss.
 * 2. **It has a budget that will actually bind.** A laptop with no retention
 *    policy wants every blob; a phone with 8 GB against a 60k-item library is
 *    the only honest consumer of `Elided`, and the reason the media plan calls
 *    this phase the validation of Phase 0's residency work.
 * 3. **Its pages are smaller.** See {@link MOBILE_PAGE_LIMIT}.
 */

import { createHLCClock } from "@starkeep/protocol-primitives";
import { SqliteDatabaseAdapter, type SqliteDriver } from "@starkeep/storage-sqlite";
import {
  createSyncEngine,
  createSqliteSyncStateStore,
  type NodeRetentionPolicy,
  type SyncEngine,
  type SyncTransport,
} from "@starkeep/sync-engine";
import type { DatabaseAdapter, ObjectStorageAdapter } from "@starkeep/storage-adapter";

/**
 * How many records one exchange page carries on a phone.
 *
 * Deliberately far below the server's 1000. Constraint 2 of the phase — no work
 * item may assume more than a few seconds — is not a suggestion here: the OS
 * decides when the app stops, and a page that takes thirty seconds to apply is
 * a page that gets abandoned partway on a real handset, over and over, making
 * progress impossible rather than merely slow.
 *
 * Smaller pages mean more round trips, which is the correct trade when the
 * alternative is a round trip that never completes. The watermark makes an
 * abandoned page free to retry, so the only cost of being wrong in this
 * direction is bandwidth.
 */
export const MOBILE_PAGE_LIMIT = 100;

/** Matching scan page — the responder-side equivalent of the same argument. */
export const MOBILE_SCAN_PAGE_SIZE = 100;

export interface MobileNodeOptions {
  readonly nodeId: string;
  /** Where op-sqlite should put the database. */
  readonly databasePath: string;
  readonly sqliteDriver: SqliteDriver;
  readonly localObjectStorage: ObjectStorageAdapter;
  /** The cloud, reached over whatever transport the shell supplies. */
  readonly transport: SyncTransport;
  readonly remoteObjectStorage: ObjectStorageAdapter;
  /**
   * The phone's retention policy.
   *
   * Optional, and its absence means "keep everything" — the same default a
   * laptop has. That is deliberately the *wrong* setting for a phone and is
   * still the right default: a node that cannot yet be told its budget must not
   * silently start declining data, because the failure mode of over-fetching is
   * a full disk and the failure mode of under-fetching is a photo that is
   * quietly nowhere.
   */
  readonly retention?: NodeRetentionPolicy;
  readonly wallClock?: () => number;
}

export interface MobileNode {
  readonly databaseAdapter: DatabaseAdapter;
  readonly objectStorage: ObjectStorageAdapter;
  readonly engine: SyncEngine;
  /** Run one exchange. Safe to abandon; the watermark makes it resumable. */
  exchange(): Promise<unknown>;
  close(): Promise<void>;
}

/**
 * Build the phone's node.
 *
 * Everything injected rather than constructed: the op-sqlite driver, the object
 * storage and the transport are the three things that genuinely need React
 * Native, and taking them as arguments is what lets the whole assembly run in
 * Node against fakes — including a real sync exchange, which is otherwise the
 * kind of thing nobody finds out about until a device is in hand.
 */
export async function createMobileNode(options: MobileNodeOptions): Promise<MobileNode> {
  const databaseAdapter = new SqliteDatabaseAdapter({
    path: options.databasePath,
    driver: options.sqliteDriver,
  });
  await databaseAdapter.init();
  await options.localObjectStorage.init();

  const clock = createHLCClock({
    nodeId: options.nodeId,
    ...(options.wallClock ? { wallClockFunction: options.wallClock } : {}),
  });

  // The sync state lives in the same database file as the records, through the
  // raw handle. One file rather than two is not tidiness: a phone can be killed
  // between two writes, and a watermark that lives in a different file from the
  // records it describes can be newer than them after a crash — which is
  // exactly the state that makes a record invisible to sync forever.
  const syncState = createSqliteSyncStateStore({
    db: databaseAdapter.getRawDatabase(),
  });

  const engine = createSyncEngine({
    localDatabaseAdapter: databaseAdapter,
    localObjectStorage: options.localObjectStorage,
    remoteObjectStorage: options.remoteObjectStorage,
    transport: options.transport,
    clock,
    syncState,
    pageLimit: MOBILE_PAGE_LIMIT,
    scanPageSize: MOBILE_SCAN_PAGE_SIZE,
  });

  return {
    databaseAdapter,
    objectStorage: options.localObjectStorage,
    engine,
    exchange: () => engine.exchange(),
    async close() {
      await databaseAdapter.close();
      await options.localObjectStorage.close();
    },
  };
}
