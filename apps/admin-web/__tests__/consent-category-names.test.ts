/**
 * The install prompt names a grant by its categories, in the plural. A category
 * missing from the name map shows as its raw id.
 */
import { describe, expect, it } from "vitest";
import { categoriesOf } from "../src/components/LocalAppsSection";

describe("categoriesOf — the install prompt's grant heading", () => {
  it("names the example category", () => {
    expect(categoriesOf(["example/plaintext"])).toBe("Example files");
  });

  it("names each category once, in the order the grant lists them", () => {
    expect(categoriesOf(["image/jpeg", "image/png", "video/mp4"])).toBe("Images, Videos");
  });
});
