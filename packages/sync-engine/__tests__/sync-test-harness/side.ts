import { createHLCClock } from "@starkeep/core";
import {
  MockDatabaseAdapter,
  MockObjectStorageAdapter,
} from "@starkeep/storage-adapter";
import { FailingObjectStorageAdapter } from "./failure-injection.js";
import {
  FILE_RECORDS_TABLE,
  makeMockAppSource,
} from "./mock-app-source.js";
import type { Side } from "./types.js";

export interface BuildSideOptions {
  readonly role: "local" | "cloud";
  readonly nodeId: string;
  readonly wallClock: () => number;
  readonly appId: string;
}

/**
 * Build one side (local or cloud) of the harness: clock, database adapter,
 * a failing-wrappable object storage, and an in-memory app-syncable source
 * that always declares the reserved file-records table plus a generic
 * `test_rows` table for AW cases.
 */
export async function buildSide(opts: BuildSideOptions): Promise<Side> {
  const clock = createHLCClock({
    nodeId: opts.nodeId,
    wallClockFunction: opts.wallClock,
  });
  const db = new MockDatabaseAdapter();
  const baseStorage = new MockObjectStorageAdapter();
  await db.init();
  await baseStorage.init();
  // Always wrap so tests can install rules without re-plumbing storage refs.
  const storage = new FailingObjectStorageAdapter(baseStorage);

  const appSource = makeMockAppSource(opts.appId, [
    { name: FILE_RECORDS_TABLE, pkColumns: ["id"] },
    { name: "test_rows", pkColumns: ["id"] },
  ]);

  return {
    role: opts.role,
    nodeId: opts.nodeId,
    db,
    storage,
    applier: appSource.applier,
    namespaces: appSource.namespaces,
    clock,
    appRows: appSource.rows,
  };
}
