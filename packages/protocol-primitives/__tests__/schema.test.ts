import { describe, it, expect } from "vitest";
import * as v from "valibot";
import { createTypeRegistry } from "../src/schema/registry.js";
import { validateDataRecord } from "../src/schema/validator.js";
import { createHLCClock } from "../src/hlc/clock.js";
import { createDataRecord } from "../src/records/builders.js";

const recordInput = {
  type: "@test/photo",
  ownerId: "u1",
  originAppId: "test",
  contentHash: "sha256:abc",
  objectStorageKey: "shared/@test/photo/ab/sha256:abc",
  mimeType: "image/jpeg",
  sizeBytes: 256,
};

describe("TypeRegistry", () => {
  it("should register and retrieve a type", () => {
    const registry = createTypeRegistry();
    registry.register({
      name: "image-dimensions",
      namespace: "@starkeep/metadata-core",
      schema: v.object({ width: v.number(), height: v.number() }),
    });

    const definition = registry.get("@starkeep/metadata-core", "image-dimensions");
    expect(definition).toBeDefined();
    expect(definition!.name).toBe("image-dimensions");
  });

  it("should retrieve by full key", () => {
    const registry = createTypeRegistry();
    registry.register({ name: "photo", namespace: "@test", schema: v.object({}) });
    expect(registry.getByKey("@test:photo")).toBeDefined();
  });

  it("should throw on duplicate registration", () => {
    const registry = createTypeRegistry();
    const definition = { name: "photo", namespace: "@test", schema: v.object({}) };
    registry.register(definition);
    expect(() => registry.register(definition)).toThrow("already registered");
  });

  it("should return undefined for unregistered types", () => {
    const registry = createTypeRegistry();
    expect(registry.get("@test", "nonexistent")).toBeUndefined();
  });

  it("should check existence with has()", () => {
    const registry = createTypeRegistry();
    registry.register({ name: "photo", namespace: "@test", schema: v.object({}) });
    expect(registry.has("@test", "photo")).toBe(true);
    expect(registry.has("@test", "video")).toBe(false);
  });

  it("should list all registered types", () => {
    const registry = createTypeRegistry();
    registry.register({ name: "a", namespace: "@test", schema: v.object({}) });
    registry.register({ name: "b", namespace: "@test", schema: v.object({}) });
    expect(registry.list()).toHaveLength(2);
  });
});

describe("validateDataRecord", () => {
  const clock = createHLCClock({ nodeId: "test", wallClockFunction: () => 1000 });

  it("should validate a correctly built data record", () => {
    const record = createDataRecord(recordInput, clock);
    const result = validateDataRecord(record);
    expect(result.success).toBe(true);
  });

  it("should reject a record with missing required fields", () => {
    const result = validateDataRecord({ kind: "data" });
    expect(result.success).toBe(false);
  });

  it("should reject a record with wrong kind", () => {
    const record = createDataRecord(recordInput, clock);
    const result = validateDataRecord({ ...record, kind: "metadata" });
    expect(result.success).toBe(false);
  });
});
