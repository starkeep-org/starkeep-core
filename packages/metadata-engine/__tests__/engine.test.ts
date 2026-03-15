import { describe, it, expect } from "vitest";
import {
  createHLCClock,
  createDataRecord,
  type StarkeepId,
} from "@starkeep/core";
import {
  MockDatabaseAdapter,
  MockObjectStorageAdapter,
} from "@starkeep/storage-adapter";
import { createMetadataEngine } from "../src/engine.js";
import { createGeneratorRegistry } from "../src/generator-registry.js";
import { createDependencyGraph } from "../src/dependency-graph.js";
import { GeneratorNotFoundError } from "../src/errors.js";
import type { GeneratingFunctionDefinition } from "../src/types.js";

function createTestSetup() {
  const clock = createHLCClock({
    nodeId: "test-node",
    wallClockFunction: () => 1000,
  });
  const databaseAdapter = new MockDatabaseAdapter();
  const objectStorageAdapter = new MockObjectStorageAdapter();
  const generatorRegistry = createGeneratorRegistry();
  const dependencyGraph = createDependencyGraph();

  const engine = createMetadataEngine({
    databaseAdapter,
    objectStorageAdapter,
    clock,
    ownerId: "test-owner",
    generatorRegistry,
    dependencyGraph,
  });

  return {
    clock,
    databaseAdapter,
    objectStorageAdapter,
    generatorRegistry,
    dependencyGraph,
    engine,
  };
}

function createDimensionsGenerator(): GeneratingFunctionDefinition {
  return {
    generatorId: "@test:dimensions",
    generatorVersion: 1,
    inputTypes: ["@test/photo"],
    dependsOn: [],
    generate: async () => ({
      value: { width: 1920, height: 1080 },
    }),
  };
}

function createThumbnailGenerator(): GeneratingFunctionDefinition {
  return {
    generatorId: "@test:thumbnail",
    generatorVersion: 1,
    inputTypes: ["@test/photo"],
    dependsOn: ["@test:dimensions"],
    generate: async () => ({
      value: { thumbnailKey: "thumb-123" },
    }),
  };
}

describe("createMetadataEngine", () => {
  describe("generate", () => {
    it("should generate metadata for a data record", async () => {
      const { engine, databaseAdapter, generatorRegistry, clock } =
        createTestSetup();

      const generator = createDimensionsGenerator();
      generatorRegistry.register(generator);

      const dataRecord = createDataRecord(
        { type: "@test/photo", ownerId: "test-owner" },
        clock,
      );
      await databaseAdapter.init();
      await databaseAdapter.put(dataRecord);

      const result = await engine.generate({
        generatorId: "@test:dimensions",
        targetId: dataRecord.id,
        mode: "on-demand",
      });

      expect(result.metadataRecord.kind).toBe("metadata");
      expect(result.metadataRecord.value).toEqual({
        width: 1920,
        height: 1080,
      });
      expect(result.metadataRecord.generatorId).toBe("@test:dimensions");
      expect(result.wasStale).toBe(false);
      expect(result.skippedBecauseCached).toBe(false);
    });

    it("should skip generation if inputs unchanged (cached)", async () => {
      const { engine, databaseAdapter, generatorRegistry, clock } =
        createTestSetup();

      const generator = createDimensionsGenerator();
      generatorRegistry.register(generator);

      const dataRecord = createDataRecord(
        { type: "@test/photo", ownerId: "test-owner" },
        clock,
      );
      await databaseAdapter.init();
      await databaseAdapter.put(dataRecord);

      const firstResult = await engine.generate({
        generatorId: "@test:dimensions",
        targetId: dataRecord.id,
        mode: "on-demand",
      });

      const secondResult = await engine.generate({
        generatorId: "@test:dimensions",
        targetId: dataRecord.id,
        mode: "on-demand",
      });

      expect(secondResult.skippedBecauseCached).toBe(true);
      expect(secondResult.metadataRecord.id).toBe(
        firstResult.metadataRecord.id,
      );
    });

    it("should throw if generator not found", async () => {
      const { engine } = createTestSetup();

      await expect(
        engine.generate({
          generatorId: "@test:nonexistent",
          targetId: "some-id" as StarkeepId,
          mode: "on-demand",
        }),
      ).rejects.toThrow(GeneratorNotFoundError);
    });

    it("should throw if target record not found", async () => {
      const { engine, databaseAdapter, generatorRegistry } = createTestSetup();

      generatorRegistry.register(createDimensionsGenerator());
      await databaseAdapter.init();

      await expect(
        engine.generate({
          generatorId: "@test:dimensions",
          targetId: "nonexistent-id" as StarkeepId,
          mode: "on-demand",
        }),
      ).rejects.toThrow("Target data record not found");
    });
  });

  describe("generateAll", () => {
    it("should generate all metadata in dependency order", async () => {
      const {
        engine,
        databaseAdapter,
        generatorRegistry,
        dependencyGraph,
        clock,
      } = createTestSetup();

      const dimensionsGenerator = createDimensionsGenerator();
      const thumbnailGenerator = createThumbnailGenerator();

      generatorRegistry.register(dimensionsGenerator);
      generatorRegistry.register(thumbnailGenerator);
      dependencyGraph.addGenerator(dimensionsGenerator);
      dependencyGraph.addGenerator(thumbnailGenerator);

      const dataRecord = createDataRecord(
        { type: "@test/photo", ownerId: "test-owner" },
        clock,
      );
      await databaseAdapter.init();
      await databaseAdapter.put(dataRecord);

      const results = await engine.generateAll(dataRecord.id, "@test/photo");

      expect(results).toHaveLength(2);
      expect(results[0].metadataRecord.generatorId).toBe("@test:dimensions");
      expect(results[1].metadataRecord.generatorId).toBe("@test:thumbnail");
    });
  });

  describe("checkStaleness", () => {
    it("should return false for fresh metadata", async () => {
      const { engine, databaseAdapter, generatorRegistry, clock } =
        createTestSetup();

      generatorRegistry.register(createDimensionsGenerator());

      const dataRecord = createDataRecord(
        { type: "@test/photo", ownerId: "test-owner" },
        clock,
      );
      await databaseAdapter.init();
      await databaseAdapter.put(dataRecord);

      const result = await engine.generate({
        generatorId: "@test:dimensions",
        targetId: dataRecord.id,
        mode: "on-demand",
      });

      const isStale = await engine.checkStaleness(result.metadataRecord.id);
      expect(isStale).toBe(false);
    });

    it("should return true for outdated generator version", async () => {
      const { engine, databaseAdapter, generatorRegistry, clock } =
        createTestSetup();

      const generator = createDimensionsGenerator();
      generatorRegistry.register(generator);

      const dataRecord = createDataRecord(
        { type: "@test/photo", ownerId: "test-owner" },
        clock,
      );
      await databaseAdapter.init();
      await databaseAdapter.put(dataRecord);

      const result = await engine.generate({
        generatorId: "@test:dimensions",
        targetId: dataRecord.id,
        mode: "on-demand",
      });

      // Simulate version bump by modifying the metadata record
      const updatedMetadata = {
        ...result.metadataRecord,
        generatorVersion: 0,
      };
      await databaseAdapter.put(updatedMetadata);

      const isStale = await engine.checkStaleness(result.metadataRecord.id);
      expect(isStale).toBe(true);
    });
  });
});
