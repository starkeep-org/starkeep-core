/**
 * The `appId → size-class label key` map a node resolves classes with.
 *
 * Derived from the manifests the registry already stores, rather than kept as a
 * column beside the declared label keys — the marker is a manifest field, and a
 * second copy of it is a second thing that can disagree with the first.
 *
 * What this map decides is which app's rungs are legible. An app missing from
 * it does not lose its bytes; its derivatives fall to a coarser rung inside the
 * same namespace. An app *wrongly* in it would be reading rungs from a key its
 * author meant for something else.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initializeLocalSchema } from "@starkeep/storage-sqlite";
import type { AppManifest } from "@starkeep/admin-manifest";
import {
  deleteAppRegistry,
  insertAppRegistry,
  setAppStatus,
  sizeClassKeysByApp,
} from "../src/local/registry.js";

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  initializeLocalSchema(db);
});

function register(
  appId: string,
  labelKeys: Array<{ key: string; description: string; sizeClass?: boolean }>,
): void {
  insertAppRegistry(
    db,
    appId,
    {
      id: appId,
      name: appId,
      version: "1.0.0",
      tier: "official",
      infraRequirements: { labelKeys },
    } as unknown as AppManifest,
    "secret",
  );
}

describe("sizeClassKeysByApp", () => {
  it("reports the marked key, and only the marked key", () => {
    register("photos", [
      { key: "rendition", description: "which rung", sizeClass: true },
      { key: "crop", description: "a user crop" },
    ]);
    expect(sizeClassKeysByApp(db)).toEqual({ photos: "rendition" });
  });

  // The gap the map closes: with one hard-coded app, every other app's
  // derivatives matched nothing and were classified as originals — the most
  // protected tier, and the one that refuses to evict.
  it("reads every registered app's ladder at once", () => {
    register("photos", [{ key: "rendition", description: "which rung", sizeClass: true }]);
    register("sketcher", [{ key: "derived-size", description: "which rung", sizeClass: true }]);
    expect(sizeClassKeysByApp(db)).toEqual({
      photos: "rendition",
      sketcher: "derived-size",
    });
  });

  // The ordinary case. Most apps derive nothing, and an app with no marked key
  // must not be guessed into one.
  it("omits an app that marks no key", () => {
    register("notes", [{ key: "starred", description: "starred" }]);
    expect(sizeClassKeysByApp(db)).toEqual({});
  });

  it("omits an app that declares no keys at all", () => {
    register("bare", []);
    expect(sizeClassKeysByApp(db)).toEqual({});
  });

  // A local upgrade is an uninstall and a reinstall — `installLocal`
  // short-circuits an app that is already active, so the registry row is
  // written once and removed on uninstall. That is what keeps this map from
  // going stale: there is no in-place update for it to drift from, and only one
  // copy of the fact to begin with.
  it("follows the marker across an uninstall and reinstall", () => {
    register("photos", [{ key: "rendition", description: "which rung", sizeClass: true }]);
    deleteAppRegistry(db, "photos");
    register("photos", [{ key: "rung", description: "renamed", sizeClass: true }]);
    expect(sizeClassKeysByApp(db)).toEqual({ photos: "rung" });
  });

  it("drops an app from the map once its registry row is gone", () => {
    register("photos", [{ key: "rendition", description: "which rung", sizeClass: true }]);
    deleteAppRegistry(db, "photos");
    expect(sizeClassKeysByApp(db)).toEqual({});
  });

  // Not filtered by install status on purpose: the map exists to read label
  // rows that already exist, and a half-removed app's rows are exactly the ones
  // that would otherwise be misread as originals.
  it("still reports an app that is mid-uninstall", () => {
    register("photos", [{ key: "rendition", description: "which rung", sizeClass: true }]);
    setAppStatus(db, "photos", "uninstalling");
    expect(sizeClassKeysByApp(db)).toEqual({ photos: "rendition" });
  });

  it("is empty on a node with nothing installed", () => {
    expect(sizeClassKeysByApp(db)).toEqual({});
  });
});
