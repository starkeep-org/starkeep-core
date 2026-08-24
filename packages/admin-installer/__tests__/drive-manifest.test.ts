/**
 * Drive's anonymous surface, pinned.
 *
 * Drive is a full cloud principal: the always-on sync channel ships every
 * shared record the user owns to `/apps/starkeep-drive/*`, and it holds
 * `fileAccessAll` plus the User-Data-Owner boundary. The one thing that keeps
 * it out of the app-authentication work is that it has no compute, so there is
 * no Lambda and nothing on the internet to reach.
 *
 * That is a property of one line of JSON, and JSON cannot carry a comment
 * saying what depends on it. This test carries it instead. If it fails, the
 * change is not a routine manifest edit — it is an event requiring the
 * reachability pass in `review-reachability-pass.md`, because a Drive with
 * compute is structurally identical to Photos and Memo except that an
 * unauthenticated one leaks everything the user owns rather than one library.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { appManifestSchema } from "@starkeep/admin-manifest";

const manifest = appManifestSchema.parse(
  JSON.parse(
    readFileSync(
      resolve(__dirname, "..", "builtin-apps", "starkeep-drive", "manifest.json"),
      "utf8",
    ),
  ),
);

describe("the starkeep-drive built-in manifest", () => {
  it("has no compute, which is the whole reason it has no anonymous surface", () => {
    expect(manifest.infraRequirements.compute.enabled).toBe(false);
    expect(manifest.infraRequirements.compute.handlers ?? []).toHaveLength(0);
  });

  it("still holds the powers that make the previous assertion matter", () => {
    // If these ever stop being true the test above is still correct, but it is
    // guarding much less; asserting them here keeps the reasoning visible.
    expect(manifest.infraRequirements.fileAccessAll).toBe(true);
  });
});
