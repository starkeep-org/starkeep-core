/**
 * The install prompt names a grant by its categories, in the plural. A category
 * missing from the name map shows as its raw id, such as `model3d`.
 */
import { describe, expect, it } from "vitest";
import { APP_GRANTABLE_CATEGORIES } from "../../../packages/protocol-primitives/src/types/core-types";
import { categoriesOf } from "../src/components/LocalAppsSection";

describe("categoriesOf — the install prompt's grant heading", () => {
  it.each(APP_GRANTABLE_CATEGORIES)("names the %s category rather than showing its id", (id) => {
    const name = categoriesOf([`${id}/x`]);
    expect(name).not.toBe(id);
    expect(name).toMatch(/^[A-Z0-9]/);
  });

  it("names the example category", () => {
    expect(categoriesOf(["example/plaintext"])).toBe("Example files");
  });

  it("names each category once, in the order the grant lists them", () => {
    expect(categoriesOf(["image/jpeg", "image/png", "video/mp4"])).toBe("Images, Videos");
  });
});
