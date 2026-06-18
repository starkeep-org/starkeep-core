import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateManifest } from "../src/validate.js";
import { isKnownType } from "@starkeep/protocol-primitives";
import { appManifestSchema, type AppManifest } from "../src/schema.js";

// Snapshot of starkeep-apps/photos/starkeep.manifest.json — the canonical
// real-world manifest. If the photos app changes its manifest, refresh this
// fixture; the suite asserts the platform contract, not photos' choices.
const photosRaw = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/photos.manifest.json", import.meta.url)), "utf8"),
);

/** Minimal valid manifest an ordinary installable app could ship. */
function minimal(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "test-app",
    name: "Test App",
    version: "1.0.0",
    tier: "community",
    ...over,
  };
}

describe("photos fixture (full real manifest)", () => {
  it("validates and round-trips typed with defaults filled", () => {
    const result = validateManifest(photosRaw);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
    const m = result.manifest as AppManifest;
    expect(m.id).toBe("photos");
    expect(m.targets).toEqual(["local", "cloud"]);
    // Defaults applied by the schema:
    expect(m.protocolMinVersion).toBe("1.0.0");
    expect(m.infraRequirements.fileAccessAll).toBe(false);
    expect(m.infraRequirements.brokerPower).toBe(false);
    expect(m.infraRequirements.appSpecificSyncable.files).toBe(true);
    expect(m.infraRequirements.appSpecificSyncable.tables).toHaveLength(1);
    expect(m.localRun?.cwd).toBe(".");
    // Handler defaults: runtime + auth on the api handler (auth unspecified → jwt)
    const api = m.infraRequirements.compute.handlers.find((h) => h.name === "api");
    expect(api?.runtime).toBe("nodejs22.x");
    expect(api?.auth).toBe("jwt");
    const staticHandler = m.infraRequirements.compute.handlers.find((h) => h.name === "static");
    expect(staticHandler?.auth).toBe("public");
    // Re-parsing the typed output is stable (round-trip)
    expect(appManifestSchema.parse(m)).toEqual(m);
  });

  it("derives implied categories from declared extensions", () => {
    const result = validateManifest(photosRaw);
    expect(result.impliedCategories).toEqual(["image"]);
  });

  it("warns that metadataWrite is redundant with readwrite (but stays valid)", () => {
    const result = validateManifest(photosRaw);
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes("metadataWrite is redundant"))).toBe(true);
  });
});

describe("id-bound privilege flags", () => {
  it("rejects fileAccessAll for any id except starkeep-drive", () => {
    const result = validateManifest(
      minimal({ infraRequirements: { fileAccessAll: true } }),
    );
    expect(result.valid).toBe(false);
    expect(result.manifest).toBeNull();
    expect(result.errors.some((e) => e.includes("fileAccessAll"))).toBe(true);
  });

  it("accepts fileAccessAll for starkeep-drive", () => {
    const result = validateManifest(
      minimal({ id: "starkeep-drive", tier: "official", infraRequirements: { fileAccessAll: true } }),
    );
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("rejects brokerPower for any id except cloud-data-server", () => {
    const result = validateManifest(
      minimal({ infraRequirements: { brokerPower: true } }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("brokerPower"))).toBe(true);
  });

  it("accepts brokerPower for cloud-data-server", () => {
    const result = validateManifest(
      minimal({ id: "cloud-data-server", tier: "official", infraRequirements: { brokerPower: true } }),
    );
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("rejects the @starkeep/ id prefix for community apps", () => {
    const result = validateManifest(minimal({ id: "@starkeep/sneaky" }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("@starkeep/"))).toBe(true);
  });

  it("allows the @starkeep/ id prefix for official apps", () => {
    const result = validateManifest(minimal({ id: "@starkeep/blessed", tier: "official" }));
    expect(result.valid).toBe(true);
  });
});

describe("syncable table column rules", () => {
  function withTable(columns: unknown[]): Record<string, unknown> {
    return minimal({
      infraRequirements: {
        appSpecificSyncable: { tables: [{ name: "notes", columns }] },
      },
    });
  }

  it("rejects the reserved updated_at / deleted_at column names", () => {
    for (const name of ["updated_at", "deleted_at"]) {
      const result = validateManifest(withTable([{ name, type: "text" }]));
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("reserved"))).toBe(true);
    }
  });

  it("enforces snake_case column names", () => {
    for (const bad of ["camelCase", "9starts_with_digit", "has-dash", "has space"]) {
      const result = validateManifest(withTable([{ name: bad, type: "text" }]));
      expect(result.valid, `column name "${bad}" should be rejected`).toBe(false);
    }
    const ok = validateManifest(withTable([{ name: "_leading_underscore_ok", type: "text" }]));
    expect(ok.valid).toBe(true);
  });

  it("enforces the column type whitelist", () => {
    for (const bad of ["varchar", "timestamp", "json", "TEXT"]) {
      const result = validateManifest(withTable([{ name: "col", type: bad }]));
      expect(result.valid, `column type "${bad}" should be rejected`).toBe(false);
    }
    for (const good of ["text", "integer", "real", "blob", "boolean"]) {
      const result = validateManifest(withTable([{ name: "col", type: good }]));
      expect(result.valid, `column type "${good}" should be accepted`).toBe(true);
    }
  });

  it("rejects snake_case violations in table names and requires at least one column", () => {
    const badName = validateManifest(
      minimal({
        infraRequirements: {
          appSpecificSyncable: { tables: [{ name: "BadName", columns: [{ name: "c", type: "text" }] }] },
        },
      }),
    );
    expect(badName.valid).toBe(false);
    const noColumns = validateManifest(
      minimal({
        infraRequirements: { appSpecificSyncable: { tables: [{ name: "empty", columns: [] }] } },
      }),
    );
    expect(noColumns.valid).toBe(false);
  });
});

describe("file access types", () => {
  function withTypes(types: string[]): Record<string, unknown> {
    return minimal({
      infraRequirements: {
        fileAccess: [{ types, access: "read", rationale: "test" }],
      },
    });
  }

  it("rejects type ids that are not `<category>/<format>` shaped", () => {
    for (const bad of ["IMAGE/JPEG", "image", "image/", "/jpeg", "image jpeg"]) {
      const result = validateManifest(withTypes([bad]));
      expect(result.valid, `type "${bad}" should be rejected`).toBe(false);
    }
  });

  it("rejects type ids outside the platform registry (the `other` set is unreachable)", () => {
    const result = validateManifest(withTypes(["image/bogus"]));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("not in the platform type registry"))).toBe(true);
    expect(isKnownType("image/bogus")).toBe(false);
  });

  it("rejects the `other/other` catch-all even though it is a registered type", () => {
    // other/other is in the registry (isKnownType is true), so the registry
    // check alone would let it through — validation must reject it as the
    // Drive-only catch-all, keeping `other` ungrantable to installable apps.
    expect(isKnownType("other/other")).toBe(true);
    const result = validateManifest(withTypes(["other/other"]));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('Drive-only "other" catch-all'))).toBe(true);
  });

  it("requires at least one type per fileAccess entry", () => {
    const result = validateManifest(withTypes([]));
    expect(result.valid).toBe(false);
  });

  it("accepts duplicate types across entries (categories deduped)", () => {
    // Pin: duplicates are not an error today; impliedCategories is a set.
    const result = validateManifest(
      minimal({
        infraRequirements: {
          fileAccess: [
            { types: ["image/jpeg"], access: "read", rationale: "a" },
            { types: ["image/jpeg", "image/png"], access: "readwrite", rationale: "b" },
          ],
        },
      }),
    );
    expect(result.valid).toBe(true);
    expect(result.impliedCategories).toEqual(["image"]);
  });

  it("defaults to empty fileAccess with no implied categories", () => {
    const result = validateManifest(minimal());
    expect(result.valid).toBe(true);
    expect(result.manifest?.infraRequirements.fileAccess).toEqual([]);
    expect(result.impliedCategories).toEqual([]);
  });
});

describe("compute handlers", () => {
  it("rejects compute.enabled with zero handlers", () => {
    const result = validateManifest(
      minimal({ infraRequirements: { compute: { enabled: true, handlers: [] } } }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("no handlers"))).toBe(true);
  });

  it("accepts arbitrary route strings (route parsing is an install-time concern)", () => {
    // Pin: the manifest schema does not validate "METHOD /path" shape; the
    // installer's gateway program is where unparseable routes must fail.
    const result = validateManifest(
      minimal({
        infraRequirements: {
          compute: {
            enabled: true,
            handlers: [{ name: "h", handler: "index.handler", routes: ["not a route"] }],
          },
        },
      }),
    );
    expect(result.valid).toBe(true);
  });

  it("enforces memory and timeout bounds", () => {
    const tooBig = validateManifest(
      minimal({
        infraRequirements: {
          compute: {
            enabled: true,
            handlers: [{ name: "h", handler: "index.handler", memoryMb: 20000 }],
          },
        },
      }),
    );
    expect(tooBig.valid).toBe(false);
  });
});

describe("targets and localRun", () => {
  it("defaults targets to [local]", () => {
    const result = validateManifest(minimal());
    expect(result.manifest?.targets).toEqual(["local"]);
  });

  it("rejects unknown targets", () => {
    const result = validateManifest(minimal({ targets: ["edge"] }));
    expect(result.valid).toBe(false);
  });

  it("localRun is optional and rejects an empty command", () => {
    expect(validateManifest(minimal()).manifest?.localRun).toBeUndefined();
    const bad = validateManifest(minimal({ localRun: { command: "" } }));
    expect(bad.valid).toBe(false);
  });

  it("schema-level failures report paths in error strings", () => {
    const result = validateManifest({ id: "", name: "x", version: "1", tier: "nope" });
    expect(result.valid).toBe(false);
    expect(result.manifest).toBeNull();
    expect(result.errors.some((e) => e.startsWith("id:"))).toBe(true);
    expect(result.errors.some((e) => e.startsWith("tier:"))).toBe(true);
  });
});
