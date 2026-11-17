/**
 * What the delete-data dialog tells the operator about the cloud's copy.
 *
 * `cloudCopy` decides whether the dialog warns that the deletion loses
 * changes. A "current" answer for a machine that holds rows the cloud never
 * received would let the operator delete them without that warning, so each
 * way a machine can be ahead of the cloud gets a case here.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { SqliteDatabaseAdapter } from "@starkeep/storage-sqlite";
import type { RawDatabase } from "@starkeep/storage-adapter";
import { serializeHLC, type HLCTimestamp } from "@starkeep/protocol-primitives";
import { nodeSqliteDriver } from "../../../packages/storage-sqlite/src/node-driver.js";
import { getAppSyncableNamespace } from "../../../packages/storage-sqlite/src/index.js";
import { createSqliteSyncStateStore } from "../../../packages/sync-engine/src/sync-state-sqlite.js";
import { createSqliteUploadQueueStore } from "../../../packages/sync-engine/src/upload-queue-store.js";
import { installLocal } from "../../../packages/admin-installer/src/local/installer.js";
import { buildAppDataPreview } from "../app-data-preview.js";
import { createPerAppSyncStateStore } from "../per-app-sync-state-store.js";

const APP = "keeper";

const MANIFEST = {
  id: APP,
  name: "Keeper",
  version: "1.0.0",
  tier: "community",
  infraRequirements: {
    appSpecificSyncable: {
      files: true,
      tables: [
        {
          name: "notes",
          columns: [
            { name: "id", type: "text", primaryKey: true, notNull: true },
            { name: "body", type: "text" },
          ],
        },
      ],
    },
  },
};

const hlc = (wallTime: number, nodeId: string): HLCTimestamp => ({ wallTime, counter: 0, nodeId });

describe("buildAppDataPreview's cloud copy", () => {
  let db: RawDatabase;

  beforeEach(async () => {
    const adapter = new SqliteDatabaseAdapter({ path: ":memory:", driver: nodeSqliteDriver });
    await adapter.init();
    db = adapter.getRawDatabase();
    installLocal(db as Parameters<typeof installLocal>[0], MANIFEST);
  });

  function insertNote(id: string, at: HLCTimestamp, deleted = false): void {
    const ts = serializeHLC(at);
    db.prepare(
      `INSERT INTO ${APP}_syncable_notes (id, body, updated_at, node_id, deleted_at) VALUES (?, 'x', ?, ?, ?)`,
    ).run(id, ts, at.nodeId, deleted ? ts : null);
  }

  async function cloudHeld(watermarks: Record<string, HLCTimestamp>): Promise<void> {
    const store = createPerAppSyncStateStore(db, createSqliteSyncStateStore({ db }), APP);
    await store.setPeerWatermarks(watermarks);
  }

  function preview() {
    const ns = getAppSyncableNamespace(db, APP)!;
    return buildAppDataPreview(db, APP, ns.tables, ns.filesEnabled);
  }

  it("is none when this machine never exchanged the app's data with the cloud", () => {
    insertNote("a", hlc(1000, "laptop"));
    expect(preview().cloudCopy).toBe("none");
  });

  it("is current when the cloud held every author's newest row", async () => {
    insertNote("a", hlc(1000, "laptop"));
    insertNote("b", hlc(2000, "phone"));
    await cloudHeld({ laptop: hlc(1000, "laptop"), phone: hlc(3000, "phone") });
    expect(preview().cloudCopy).toBe("current");
  });

  it("is behind when a row is newer than what the cloud held for its author", async () => {
    insertNote("a", hlc(1000, "laptop"));
    insertNote("b", hlc(1500, "laptop"));
    await cloudHeld({ laptop: hlc(1000, "laptop") });
    expect(preview().cloudCopy).toBe("behind");
  });

  it("is behind when the cloud held nothing from one author", async () => {
    insertNote("a", hlc(1000, "laptop"));
    insertNote("b", hlc(1000, "desktop"));
    await cloudHeld({ laptop: hlc(1000, "laptop") });
    expect(preview().cloudCopy).toBe("behind");
  });

  // A tombstone the cloud has not received is a change the deletion loses,
  // even though the row counts leave it out.
  it("is behind when only an unsent tombstone is newer, and the count skips it", async () => {
    insertNote("a", hlc(1000, "laptop"));
    insertNote("b", hlc(2000, "laptop"), true);
    await cloudHeld({ laptop: hlc(1000, "laptop") });
    const p = preview();
    expect(p.cloudCopy).toBe("behind");
    expect(p.totalRows).toBe(1);
  });

  it("is behind when a file waits in the app's upload queue", async () => {
    insertNote("a", hlc(1000, "laptop"));
    await cloudHeld({ laptop: hlc(1000, "laptop") });
    createSqliteUploadQueueStore({ db, channel: APP }).enqueue({
      key: `apps/${APP}/user-1/syncable/a.bin`,
      hlc: hlc(1000, "laptop"),
      recordId: null,
      itemId: "a",
      sizeBytes: 3,
      fileHash: "h",
      mimeType: null,
      tier: "full",
    });
    expect(preview().cloudCopy).toBe("behind");
  });

  it("ignores another channel's queued uploads", async () => {
    insertNote("a", hlc(1000, "laptop"));
    await cloudHeld({ laptop: hlc(1000, "laptop") });
    createSqliteUploadQueueStore({ db, channel: "other-app" }).enqueue({
      key: "apps/other-app/user-1/syncable/a.bin",
      hlc: hlc(1000, "laptop"),
      recordId: null,
      itemId: "a",
      sizeBytes: 3,
      fileHash: "h",
      mimeType: null,
      tier: "full",
    });
    expect(preview().cloudCopy).toBe("current");
  });
});
