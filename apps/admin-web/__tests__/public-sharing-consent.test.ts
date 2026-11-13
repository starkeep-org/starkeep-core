/**
 * The install dialog's public-links sentence names what a link can expose,
 * taken from the app's own grants.
 */
import { describe, expect, it } from "vitest";
import { publicSharingConsent, type ManifestSummary } from "../src/lib/app-types";

function manifest(ir: ManifestSummary["infraRequirements"]): ManifestSummary {
  return { name: "Photos", infraRequirements: { publicSharing: true, ...ir } };
}

describe("publicSharingConsent", () => {
  it("says nothing for an app without public sharing", () => {
    expect(publicSharingConsent({ name: "Photos", infraRequirements: {} })).toBeNull();
  });

  it("names two granted categories", () => {
    const m = manifest({
      fileAccess: [
        { types: ["image/jpeg", "image/png"], access: "readwrite", rationale: "r" },
        { types: ["video/mp4"], access: "readwrite", rationale: "r" },
      ],
    });
    expect(publicSharingConsent(m)).toBe(
      "Photos can create web links to your images and videos. Anyone who has a valid link can view the content you share without signing in.",
    );
  });

  it("names the example category", () => {
    const m = manifest({
      fileAccess: [{ types: ["example/plaintext"], access: "readwrite", rationale: "r" }],
    });
    expect(publicSharingConsent(m)).toMatch(/to your example files\./);
  });

  it("lists three categories with a final and", () => {
    const m = manifest({
      fileAccess: [
        { types: ["image/png", "audio/mpeg", "model3d/gltf"], access: "read", rationale: "r" },
      ],
    });
    expect(publicSharingConsent(m)).toMatch(/to your images, audio and 3D models\./);
  });

  it("says files for an app with every file or with no grant", () => {
    expect(publicSharingConsent(manifest({ fileAccessAll: true }))).toMatch(/to your files\./);
    expect(publicSharingConsent(manifest({}))).toMatch(/to your files\./);
  });
});
