/**
 * App-specific data plane: declared-table CRUD, isolation between apps, and
 * the per-app file namespace. (Plan §3 "App-specific data".)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { startLocalDataServer, type LocalDataServer } from "@starkeep/testkit";
import { installApp, testAppManifest, type InstalledApp } from "./helpers.js";

let server: LocalDataServer;
let appA: InstalledApp; // declares `notes` + files:true
let appB: InstalledApp; // declares its own `notes` + files:false
let noSyncable: InstalledApp; // no appSpecificSyncable at all

beforeAll(async () => {
  server = await startLocalDataServer();
  appA = await installApp(server, testAppManifest());
  appB = await installApp(server, {
    id: "app-b",
    name: "App B",
    version: "1.0.0",
    tier: "community",
    infraRequirements: {
      appSpecificSyncable: {
        files: false,
        tables: [
          {
            name: "notes",
            columns: [
              { name: "note_id", type: "text", primaryKey: true, notNull: true },
              { name: "body", type: "text" },
            ],
          },
        ],
      },
    },
  });
  noSyncable = await installApp(server, {
    id: "no-syncable",
    name: "No Syncable",
    version: "1.0.0",
    tier: "community",
    infraRequirements: {},
  });
}, 60_000);

afterAll(async () => {
  await server.stop();
});

describe("declared-table CRUD", () => {
  it("inserts, queries, updates, and deletes rows", async () => {
    const insert = await appA.fetch("/app-data/db/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ row: { note_id: "n1", body: "hello" } }),
    });
    expect(insert.status).toBe(200);

    const query = await appA.fetch("/app-data/db/notes?note_id=n1");
    const { rows } = (await query.json()) as { rows: Array<Record<string, unknown>> };
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ note_id: "n1", body: "hello" });
    // Reserved sync columns are maintained inline.
    expect(rows[0].updated_at).toBeDefined();

    const update = await appA.fetch("/app-data/db/notes", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ where: { note_id: "n1" }, patch: { body: "edited" } }),
    });
    expect(((await update.json()) as { changes: number }).changes).toBe(1);

    const del = await appA.fetch("/app-data/db/notes", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ where: { note_id: "n1" } }),
    });
    expect(((await del.json()) as { changes: number }).changes).toBe(1);

    const after = await appA.fetch("/app-data/db/notes?note_id=n1");
    expect(((await after.json()) as { rows: unknown[] }).rows).toHaveLength(0);
  });

  it("refuses an undeclared table", async () => {
    const res = await appA.fetch("/app-data/db/not_declared", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ row: { x: 1 } }),
    });
    expect(res.status).toBe(400);
  });

  it("apps with no appSpecificSyncable are refused on the db plane", async () => {
    // Pin: today the factory still builds an (empty) view, so this lands on
    // the undeclared-table 400 rather than the no-namespace 404.
    const res = await noSyncable.fetch("/app-data/db/anything");
    expect([400, 404]).toContain(res.status);
  });

  it("same-named tables in two apps are fully isolated", async () => {
    await appA.fetch("/app-data/db/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ row: { note_id: "a-row", body: "A's data" } }),
    });
    const bRows = await appB.fetch("/app-data/db/notes");
    const { rows } = (await bRows.json()) as { rows: unknown[] };
    expect(rows).toHaveLength(0);
  });
});

describe("per-app file namespace", () => {
  it("put/get/delete confined to the app's own namespace", async () => {
    const put = await appA.fetch("/app-data/files/thumbs/t1.bin", {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: Buffer.from("app-file-bytes"),
    });
    expect(put.status).toBe(200);

    const get = await appA.fetch("/app-data/files/thumbs/t1.bin");
    expect(get.status).toBe(200);
    const { url } = (await get.json()) as { url: string };
    const bytes = await fetch(url);
    expect(Buffer.from(await bytes.arrayBuffer()).toString()).toBe("app-file-bytes");

    const del = await appA.fetch("/app-data/files/thumbs/t1.bin", { method: "DELETE" });
    expect(del.status).toBe(200);
    const gone = await appA.fetch("/app-data/files/thumbs/t1.bin");
    expect(gone.status).toBe(404);
  });

  it("files plane refused for an app that declared files:false", async () => {
    const res = await appB.fetch("/app-data/files/x.bin", {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: Buffer.from("nope"),
    });
    expect([400, 404]).toContain(res.status);
  });

  it("one app's files are invisible to another", async () => {
    await appA.fetch("/app-data/files/private.bin", {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: Buffer.from("private"),
    });
    // app-b probing the same subKey resolves inside ITS namespace → absent
    // (and its files plane is disabled anyway).
    const res = await appB.fetch("/app-data/files/private.bin");
    expect([400, 404]).toContain(res.status);
  });
});

describe("reserved sync-records table", () => {
  function tableNames(): string[] {
    const db = new DatabaseSync(join(server.starkeepDir, "data.db"), { readOnly: true });
    try {
      return (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all() as Array<{ name: string }>
      ).map((r) => r.name);
    } finally {
      db.close();
    }
  }

  it("created only for apps that enabled files sync", async () => {
    const names = tableNames();
    expect(names).toContain("testapp_syncable__starkeep_sync_records"); // files: true
    expect(names).toContain("testapp_syncable_notes");
    expect(names).toContain("app_b_syncable_notes");
    expect(names.some((n) => n.startsWith("app_b_") && n.includes("_starkeep_sync_records"))).toBe(
      false,
    ); // files: false
  });
});
