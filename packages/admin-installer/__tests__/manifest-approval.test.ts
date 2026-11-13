/**
 * The install routes and the cloud CLI compare the manifest a person
 * approved with the one an install is about to use. A folder holds the raw
 * manifest, and the local registry and the dialogs may hold the validated
 * one, so the comparison must see content, not text.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateManifest } from "@starkeep/admin-manifest";
import { DEFAULT_APPS_DIR } from "../src/app-discovery.js";
import { approvesManifest, manifestDigest } from "../src/manifest-approval.js";

const raw = JSON.parse(
  readFileSync(join(DEFAULT_APPS_DIR, "starkeep.manifest.json"), "utf-8"),
) as Record<string, unknown>;
const manifest = validateManifest(raw).manifest!;

/** The same object with its keys in reverse order, at the top level. */
function reversed(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).reverse());
}

describe("approvesManifest", () => {
  it("accepts the raw manifest, the validated one, and either in another key order", () => {
    expect(JSON.stringify(raw)).not.toBe(JSON.stringify(manifest));
    for (const approved of [raw, manifest, reversed(raw), reversed({ ...manifest })]) {
      expect(approvesManifest(approved, manifest)).toBe(true);
    }
  });

  it("refuses a manifest that differs in any value", () => {
    expect(approvesManifest({ ...raw, version: "9.9.9" }, manifest)).toBe(false);
    const ir = raw.infraRequirements as Record<string, unknown>;
    expect(
      approvesManifest(
        { ...raw, infraRequirements: { ...ir, publicSharing: !ir.publicSharing } },
        manifest,
      ),
    ).toBe(false);
  });

  it("refuses something that is not a valid manifest", () => {
    expect(approvesManifest({ id: manifest.id }, manifest)).toBe(false);
    expect(approvesManifest("manifest", manifest)).toBe(false);
  });
});

describe("manifestDigest", () => {
  it("names the content, whatever the key order", () => {
    const again = validateManifest(reversed(raw)).manifest!;
    expect(manifestDigest(again)).toBe(manifestDigest(manifest));
    expect(manifestDigest(validateManifest({ ...raw, version: "9.9.9" }).manifest!)).not.toBe(
      manifestDigest(manifest),
    );
  });
});
