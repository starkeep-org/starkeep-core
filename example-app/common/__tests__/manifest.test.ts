/**
 * The names in `src/ids.ts` against `starkeep.manifest.json`. A copy of the
 * app renames both, and a name changed in one place only fails at runtime: a
 * 403 on the type, a refused label key, an undeclared table.
 */
import { describe, expect, it } from "vitest";
import manifest from "../../starkeep.manifest.json" with { type: "json" };
import { APP_ID, EXAMPLE_CATEGORY, EXAMPLE_TYPE, LABEL_KEYS, TABLES } from "../src/ids.js";

const infra = manifest.infraRequirements;

describe("ids.ts agrees with the manifest", () => {
  it("names the manifest's app id", () => {
    expect(APP_ID).toBe(manifest.id);
  });

  it("names the one type the manifest grants, and its category", () => {
    expect(infra.fileAccess.flatMap((g) => g.types)).toEqual([EXAMPLE_TYPE]);
    expect(EXAMPLE_TYPE.split("/")[0]).toBe(EXAMPLE_CATEGORY);
  });

  it("names exactly the label keys the manifest declares", () => {
    expect(Object.values(LABEL_KEYS).sort()).toEqual(infra.labelKeys.map((k) => k.key).sort());
  });

  it("names exactly the tables the manifest declares", () => {
    expect(Object.values(TABLES).sort()).toEqual(
      infra.appSpecificSyncable.tables.map((t) => t.name).sort(),
    );
  });
});
