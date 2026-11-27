/**
 * The words both install dialogs show for an app's public site.
 * `consent-cli-parity.test.tsx` in admin-web holds the dialog to them.
 */
import { describe, it, expect } from "vitest";
import { publicSiteConsent } from "../src/consent-text";

describe("publicSiteConsent", () => {
  // SITES-007
  it("names the site's address and that anyone may read it without signing in", () => {
    expect(
      publicSiteConsent({
        id: "blog",
        name: "Blog",
        infraRequirements: { publicSite: { bundleDir: "site" } },
      }),
    ).toBe(
      "Blog publishes a website at /sites/blog/ that anyone on the internet can read without signing in.",
    );
  });

  it("says nothing for an app without a site", () => {
    expect(publicSiteConsent({ id: "blog", infraRequirements: {} })).toBeNull();
  });
});
