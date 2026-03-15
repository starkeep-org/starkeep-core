import { describe, it, expect } from "vitest";
import * as v from "valibot";
import { createTypeRegistry } from "../src/schema/registry.js";
import {
  validateDataRecord,
  validateMetadataRecord,
  validateAnyRecord,
} from "../src/schema/validator.js";
import { createHLCClock } from "../src/hlc/clock.js";
import { createDataRecord, createMetadataRecord } from "../src/records/builders.js";
import { createStarkeepId } from "../src/identifiers/types.js";

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
    registry.register({
      name: "photo",
      namespace: "@test",
      schema: v.object({}),
    });

    expect(registry.getByKey("@test:photo")).toBeDefined();
  });

  it("should throw on duplicate registration", () => {
    const registry = createTypeRegistry();
    const definition = {
      name: "photo",
      namespace: "@test",
      schema: v.object({}),
    };
    registry.register(definition);
    expect(() => registry.register(definition)).toThrow("already registered");
  });

  it("should return undefined for unregistered types", () => {
    const registry = createTypeRegistry();
    expect(registry.get("@test", "nonexistent")).toBeUndefined();
  });

  it("should check existence with has()", () => {
    const registry = createTypeRegistry();
    registry.register({
      name: "photo",
      namespace: "@test",
      schema: v.object({}),
    });
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

describe("schema validation", () => {
  const clock = createHLCClock({ nodeId: "test", wallClockFunction: () => 1000 });

  describe("validateDataRecord", () => {
    it("should validate a correctly built data record", () => {
      const record = createDataRecord({ type: "@test/photo", ownerId: "u1" }, clock);
      const result = validateDataRecord(record);
      expect(result.success).toBe(true);
    });

    it("should reject a record with missing required fields", () => {
      const result = validateDataRecord({ kind: "data" });
      expect(result.success).toBe(false);
    });

    it("should reject a record with wrong kind", () => {
      const record = createDataRecord({ type: "@test/photo", ownerId: "u1" }, clock);
      const result = validateDataRecord({ ...record, kind: "metadata" });
      expect(result.success).toBe(false);
    });
  });

  describe("validateMetadataRecord", () => {
    it("should validate a correctly built metadata record", () => {
      const targetId = createStarkeepId("01ARZ3NDEKTSV4RRFFQ69G5FAV");
      const record = createMetadataRecord(
        {
          type: "@test:dims",
          ownerId: "u1",
          targetId,
          generatorId: "gen-1",
          generatorVersion: 1,
          inputHash: "hash",
          value: { width: 100 },
        },
        clock,
      );
      const result = validateMetadataRecord(record);
      expect(result.success).toBe(true);
    });
  });

  describe("validateAnyRecord", () => {
    it("should validate data records", () => {
      const record = createDataRecord({ type: "@test/photo", ownerId: "u1" }, clock);
      const result = validateAnyRecord(record);
      expect(result.success).toBe(true);
    });

    it("should validate metadata records", () => {
      const targetId = createStarkeepId("01ARZ3NDEKTSV4RRFFQ69G5FAV");
      const record = createMetadataRecord(
        {
          type: "@test:dims",
          ownerId: "u1",
          targetId,
          generatorId: "g",
          generatorVersion: 1,
          inputHash: "h",
          value: {},
        },
        clock,
      );
      const result = validateAnyRecord(record);
      expect(result.success).toBe(true);
    });

    it("should reject records with invalid kind", () => {
      const result = validateAnyRecord({ kind: "unknown" });
      expect(result.success).toBe(false);
    });
  });
});
