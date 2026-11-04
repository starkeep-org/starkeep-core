/**
 * The one markup escape the cloud data server's pages and the managed login
 * SVG share.
 */

import { describe, it, expect } from "vitest";
import { escapeMarkup } from "../src/index.js";

describe("escapeMarkup", () => {
  it("escapes the five characters that can break out of content or an attribute", () => {
    expect(escapeMarkup(`Tom & Jerry's <Photos> "here"`)).toBe(
      "Tom &amp; Jerry&#39;s &lt;Photos&gt; &quot;here&quot;",
    );
  });

  it("escapes an ampersand once, so an existing reference is not decoded", () => {
    expect(escapeMarkup("&amp;")).toBe("&amp;amp;");
  });

  it("leaves other text alone", () => {
    expect(escapeMarkup("Koller Family-2 Café 家族")).toBe("Koller Family-2 Café 家族");
  });
});
