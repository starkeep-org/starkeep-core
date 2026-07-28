/**
 * The manifest-declared label-key registry.
 *
 * The lifecycle here is deliberately asymmetric and easy to get wrong: the
 * *declarations* are revoked on uninstall and on an upgrade that drops a key,
 * but the *label rows* those keys produced are shared data and survive both.
 * That leaves live rows on an undeclared key, which is the intended steady
 * state rather than corruption — so these tests pin the asymmetry rather than
 * just the happy path.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initializeLocalSchema, sqliteCompiler as k } from "@starkeep/storage-sqlite";
import {
  insertAppLabelKeys,
  deleteAppLabelKeys,
} from "../src/local/registry.js";

describe("shared_app_label_keys registry", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    initializeLocalSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  function declaredKeys(appId: string): Array<{ key: string; description: string | null }> {
    const q = k
      .selectFrom("shared_app_label_keys")
      .select(["key", "description"])
      .where("app_id", "=", appId)
      .orderBy("key", "asc")
      .compile();
    return db.prepare(q.sql).all(...(q.parameters as string[])) as Array<{
      key: string;
      description: string | null;
    }>;
  }

  it("registers declared keys with their descriptions", () => {
    insertAppLabelKeys(db, "alpha", [
      { key: "ocr-available", description: "This app holds OCR text" },
      { key: "needs-review", description: "Flagged for a human" },
    ]);
    expect(declaredKeys("alpha")).toEqual([
      { key: "needs-review", description: "Flagged for a human" },
      { key: "ocr-available", description: "This app holds OCR text" },
    ]);
  });

  it("is readable across apps — the reason keys are declared at all", () => {
    // Discoverability is what the manifest declaration buys over a cheaper
    // runtime counter: app B can enumerate what app A publishes.
    insertAppLabelKeys(db, "alpha", [{ key: "ocr-available", description: "OCR" }]);
    insertAppLabelKeys(db, "gamma", [{ key: "quality", description: "Quality rating" }]);

    const all = db
      .prepare(
        k.selectFrom("shared_app_label_keys").select(["app_id", "key"]).compile().sql,
      )
      .all() as Array<{ app_id: string; key: string }>;
    expect(all).toHaveLength(2);
    expect(new Set(all.map((r) => `${r.app_id}/${r.key}`))).toEqual(
      new Set(["alpha/ocr-available", "gamma/quality"]),
    );
  });

  it("is idempotent, and an upgrade updates a key's description in place", () => {
    insertAppLabelKeys(db, "alpha", [{ key: "ocr-available", description: "old wording" }]);
    insertAppLabelKeys(db, "alpha", [{ key: "ocr-available", description: "new wording" }]);
    expect(declaredKeys("alpha")).toEqual([
      { key: "ocr-available", description: "new wording" },
    ]);
  });

  it("revokes a key an upgraded manifest no longer declares", () => {
    insertAppLabelKeys(db, "alpha", [
      { key: "keep-me", description: "kept" },
      { key: "drop-me", description: "dropped next time" },
    ]);
    insertAppLabelKeys(db, "alpha", [{ key: "keep-me", description: "kept" }]);

    // Not merely "stops being re-added" — actively gone, so the write path
    // starts rejecting it.
    expect(declaredKeys("alpha").map((r) => r.key)).toEqual(["keep-me"]);
  });

  it("revokes every key when an upgraded manifest declares none", () => {
    insertAppLabelKeys(db, "alpha", [{ key: "gone", description: "x" }]);
    insertAppLabelKeys(db, "alpha", []);
    expect(declaredKeys("alpha")).toEqual([]);
  });

  it("does not touch another app's declarations when one app's are revoked", () => {
    insertAppLabelKeys(db, "alpha", [{ key: "k", description: "a" }]);
    insertAppLabelKeys(db, "gamma", [{ key: "k", description: "g" }]);

    deleteAppLabelKeys(db, "alpha");

    expect(declaredKeys("alpha")).toEqual([]);
    expect(declaredKeys("gamma")).toEqual([{ key: "k", description: "g" }]);
  });

  it("uninstall drops declarations but leaves the app's label rows alone", () => {
    insertAppLabelKeys(db, "alpha", [{ key: "ocr-available", description: "OCR" }]);
    db.prepare(
      `INSERT INTO shared_record_labels
         (record_id, app_id, key, value, record_type, created_at, updated_at, node_id, deleted_at)
       VALUES ('rec1', 'alpha', 'ocr-available', '', 'image/jpeg', 't0', 't0', 'nodeA', NULL)`,
    ).run();

    deleteAppLabelKeys(db, "alpha");

    // Declarations gone...
    expect(declaredKeys("alpha")).toEqual([]);
    // ...but the assertion survives, so a reader doesn't lose annotations
    // because the producer was temporarily removed, and reinstalling
    // re-exposes them.
    const rows = db
      .prepare(`SELECT key, deleted_at FROM shared_record_labels WHERE app_id = 'alpha'`)
      .all() as Array<{ key: string; deleted_at: string | null }>;
    expect(rows).toEqual([{ key: "ocr-available", deleted_at: null }]);
  });
});
