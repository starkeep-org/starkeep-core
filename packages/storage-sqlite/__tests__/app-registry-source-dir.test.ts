/**
 * The temporary guard that adds `shared_app_registry.source_dir` to a registry
 * created before the column existed. A deployment upgrades by restarting its
 * local data server, which runs `initializeLocalSchema`.
 */

import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initializeLocalSchema } from "../src/schema/bootstrap.js";

function columns(db: DatabaseSync): string[] {
  return (
    db.prepare("SELECT name FROM pragma_table_info('shared_app_registry')").all() as Array<{
      name: string;
    }>
  ).map((c) => c.name);
}

/** The registry as it was before `source_dir`, with one installed app. */
function oldRegistry(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE shared_app_registry (
    app_id text PRIMARY KEY,
    name text NOT NULL,
    version text NOT NULL,
    tier text NOT NULL DEFAULT 'app',
    manifest text NOT NULL,
    status text NOT NULL DEFAULT 'installing',
    hmac_secret text NOT NULL,
    installed_at text NOT NULL DEFAULT (datetime('now')),
    updated_at text NOT NULL DEFAULT (datetime('now'))
  )`);
  db.prepare(
    `INSERT INTO shared_app_registry (app_id, name, version, manifest, status, hmac_secret)
     VALUES ('photos', 'Photos', '1.0.0', '{}', 'active', 'secret')`,
  ).run();
  return db;
}

describe("shared_app_registry.source_dir", () => {
  it("is created with a fresh registry", () => {
    const db = new DatabaseSync(":memory:");
    initializeLocalSchema(db);
    expect(columns(db)).toContain("source_dir");
  });

  it("is added to a registry created without it, leaving its rows intact", () => {
    const db = oldRegistry();
    initializeLocalSchema(db);
    expect(columns(db)).toContain("source_dir");
    expect(db.prepare("SELECT * FROM shared_app_registry").all()).toEqual([
      expect.objectContaining({
        app_id: "photos",
        status: "active",
        hmac_secret: "secret",
        source_dir: null,
      }),
    ]);
  });

  it("runs twice as a no-op", () => {
    const db = oldRegistry();
    initializeLocalSchema(db);
    initializeLocalSchema(db);
    expect(columns(db).filter((c) => c === "source_dir")).toHaveLength(1);
  });
});
