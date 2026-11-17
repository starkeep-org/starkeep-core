/**
 * Local uninstall keeps an app's data, and deleting it is a separate action.
 *
 * Runs the real installer against an in-memory SQLite database and reads the
 * schema back. The route-level twin is the local-data-server's
 * `admin-apps.test.ts`, which also covers files and sync state end to end.
 */

import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initializeLocalSchema, getAppSyncableNamespace } from "@starkeep/storage-sqlite";
import {
  AppInstalledError,
  NoRetainedDataError,
  deleteAppDataLocal,
  installLocal,
  uninstallLocal,
} from "../src/local/installer.js";
import { getRetainedAppData } from "../src/local/registry.js";

const MANIFEST = {
  id: "keeper",
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

type Db = DatabaseSync & Parameters<typeof installLocal>[0];

function freshDb(): Db {
  const db = new DatabaseSync(":memory:") as unknown as Db;
  initializeLocalSchema(db);
  return db;
}

function tables(db: Db): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
      name: string;
    }>
  ).map((r) => r.name);
}

function insertNote(db: Db, id: string): void {
  db.prepare(
    "INSERT INTO keeper_syncable_notes (id, body, updated_at, node_id) VALUES (?, 'x', '0', 'n')",
  ).run(id);
}

function noteIds(db: Db): string[] {
  return (db.prepare("SELECT id FROM keeper_syncable_notes").all() as Array<{ id: string }>).map(
    (r) => r.id,
  );
}

function noopDeps() {
  return { deleteFilesPrefix: async () => {}, clearSyncState: () => {} };
}

describe("uninstallLocal", () => {
  it("keeps the app's tables and rows, and records them as kept data", () => {
    const db = freshDb();
    installLocal(db, MANIFEST);
    insertNote(db, "a");

    uninstallLocal(db, "keeper");

    expect(noteIds(db)).toEqual(["a"]);
    expect(getAppSyncableNamespace(db, "keeper")).toBeNull();
    const retained = getRetainedAppData(db, "keeper");
    expect(retained).toMatchObject({ appId: "keeper", name: "Keeper", filesEnabled: true });
    expect(retained!.tables.map((t) => t.name)).toEqual(["notes", "_starkeep_sync_records"]);
  });

  it("records nothing for an app that keeps no syncable data", () => {
    const db = freshDb();
    installLocal(db, { ...MANIFEST, id: "plain", infraRequirements: {} });
    uninstallLocal(db, "plain");
    expect(getRetainedAppData(db, "plain")).toBeNull();
  });
});

describe("installLocal over kept data", () => {
  it("adopts the kept rows and deletes the kept-data record", () => {
    const db = freshDb();
    installLocal(db, MANIFEST);
    insertNote(db, "a");
    uninstallLocal(db, "keeper");

    installLocal(db, MANIFEST);

    expect(noteIds(db)).toEqual(["a"]);
    expect(getRetainedAppData(db, "keeper")).toBeNull();
    expect(getAppSyncableNamespace(db, "keeper")?.tableNames).toContain("notes");
  });
});

describe("deleteAppDataLocal", () => {
  it("refuses while the app is installed", async () => {
    const db = freshDb();
    installLocal(db, MANIFEST);
    await expect(deleteAppDataLocal(db, "keeper", noopDeps())).rejects.toBeInstanceOf(
      AppInstalledError,
    );
    expect(tables(db)).toContain("keeper_syncable_notes");
  });

  it("refuses when this node keeps no data for the app", async () => {
    const db = freshDb();
    await expect(deleteAppDataLocal(db, "keeper", noopDeps())).rejects.toBeInstanceOf(
      NoRetainedDataError,
    );
  });

  it("drops the tables, then deletes files, then clears sync state, then the record", async () => {
    const db = freshDb();
    installLocal(db, MANIFEST);
    insertNote(db, "a");
    uninstallLocal(db, "keeper");

    const order: string[] = [];
    await deleteAppDataLocal(db, "keeper", {
      deleteFilesPrefix: async (prefix) => {
        expect(tables(db)).not.toContain("keeper_syncable_notes");
        order.push(`files:${prefix}`);
      },
      clearSyncState: (appId) => {
        order.push(`sync:${appId}`);
      },
    });

    expect(order).toEqual(["files:apps/keeper/", "sync:keeper"]);
    expect(tables(db).filter((t) => t.startsWith("keeper_syncable_"))).toEqual([]);
    expect(getRetainedAppData(db, "keeper")).toBeNull();
  });

  // A failure part-way must leave the record, so the data stays listed and a
  // retry can finish. Sync state is cleared only after the files are gone.
  it("keeps the record and the sync state when deleting files fails", async () => {
    const db = freshDb();
    installLocal(db, MANIFEST);
    uninstallLocal(db, "keeper");

    let cleared = false;
    await expect(
      deleteAppDataLocal(db, "keeper", {
        deleteFilesPrefix: async () => {
          throw new Error("disk says no");
        },
        clearSyncState: () => {
          cleared = true;
        },
      }),
    ).rejects.toThrow("disk says no");

    expect(cleared).toBe(false);
    expect(getRetainedAppData(db, "keeper")).not.toBeNull();

    await deleteAppDataLocal(db, "keeper", noopDeps());
    expect(getRetainedAppData(db, "keeper")).toBeNull();
  });
});
