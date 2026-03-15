import { describe, it, expect, beforeEach } from "vitest";
import {
  createHLCClock,
  createDataRecord,
  createStarkeepId,
  type DataRecord,
} from "@starkeep/core";
import {
  MockDatabaseAdapter,
  MockObjectStorageAdapter,
} from "@starkeep/storage-adapter";
import {
  createGeneratorRegistry,
  createDependencyGraph,
  type GenerationContext,
} from "@starkeep/metadata-engine";
import { IMAGE_DIMENSIONS_GENERATOR } from "../src/generators/image-dimensions.js";
import { FILE_PROPERTIES_GENERATOR } from "../src/generators/file-properties.js";
import { TEXT_PREVIEW_GENERATOR } from "../src/generators/text-preview.js";
import { registerCoreMetadataGenerators } from "../src/register.js";

const PNG_HEADER = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
  0x00, 0x00, 0x00, 0x0d, // IHDR chunk length
  0x49, 0x48, 0x44, 0x52, // "IHDR"
  0x00, 0x00, 0x03, 0x00, // width: 768
  0x00, 0x00, 0x02, 0x00, // height: 512
  0x08, 0x02, 0x00, 0x00, 0x00, // bitdepth, colortype, etc
]);

function createMinimalJpegBuffer(width: number, height: number): Buffer {
  const widthHighByte = (width >> 8) & 0xff;
  const widthLowByte = width & 0xff;
  const heightHighByte = (height >> 8) & 0xff;
  const heightLowByte = height & 0xff;

  return Buffer.from([
    0xff, 0xd8, // JPEG SOI marker
    0xff, 0xe0, // APP0 marker
    0x00, 0x10, // APP0 length
    0x4a, 0x46, 0x49, 0x46, 0x00, // "JFIF\0"
    0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, // JFIF data
    0xff, 0xc0, // SOF0 marker
    0x00, 0x11, // SOF0 length
    0x08, // precision
    heightHighByte, heightLowByte, // height
    widthHighByte, widthLowByte, // width
    0x03, // number of components
    0x01, 0x22, 0x00, // component 1
    0x02, 0x11, 0x01, // component 2
    0x03, 0x11, 0x01, // component 3
  ]);
}

function createTestContext(
  databaseAdapter: MockDatabaseAdapter,
  objectStorageAdapter: MockObjectStorageAdapter,
): GenerationContext {
  const clock = createHLCClock({
    nodeId: "test-node",
    wallClockFunction: () => 1000,
  });

  return {
    databaseAdapter,
    objectStorageAdapter,
    clock,
    ownerId: "test-owner",
  };
}

describe("IMAGE_DIMENSIONS_GENERATOR", () => {
  let databaseAdapter: MockDatabaseAdapter;
  let objectStorageAdapter: MockObjectStorageAdapter;
  let context: GenerationContext;

  beforeEach(async () => {
    databaseAdapter = new MockDatabaseAdapter();
    objectStorageAdapter = new MockObjectStorageAdapter();
    context = createTestContext(databaseAdapter, objectStorageAdapter);
    await databaseAdapter.init();
    await objectStorageAdapter.init();
  });

  it("should have correct generator metadata", () => {
    expect(IMAGE_DIMENSIONS_GENERATOR.generatorId).toBe("@starkeep/metadata-core:image-dimensions");
    expect(IMAGE_DIMENSIONS_GENERATOR.generatorVersion).toBe(1);
    expect(IMAGE_DIMENSIONS_GENERATOR.inputTypes).toEqual(["@starkeep/photo", "@starkeep/image"]);
    expect(IMAGE_DIMENSIONS_GENERATOR.dependsOn).toEqual([]);
  });

  it("should extract dimensions from a PNG image", async () => {
    const clock = createHLCClock({ nodeId: "test-node", wallClockFunction: () => 1000 });
    const dataRecord = createDataRecord(
      {
        type: "@starkeep/photo",
        ownerId: "test-owner",
        objectStorageKey: "images/test-photo.png",
      },
      clock,
    );

    await databaseAdapter.put(dataRecord);
    await objectStorageAdapter.put("images/test-photo.png", PNG_HEADER);

    const result = await IMAGE_DIMENSIONS_GENERATOR.generate(
      { dataRecordId: dataRecord.id, dependencyIds: [], parameters: {} },
      context,
    );

    expect(result.value).toEqual({ width: 768, height: 512, format: "png" });
  });

  it("should extract dimensions from a JPEG image", async () => {
    const clock = createHLCClock({ nodeId: "test-node", wallClockFunction: () => 1000 });
    const jpegBuffer = createMinimalJpegBuffer(1024, 768);
    const dataRecord = createDataRecord(
      {
        type: "@starkeep/image",
        ownerId: "test-owner",
        objectStorageKey: "images/test-photo.jpg",
      },
      clock,
    );

    await databaseAdapter.put(dataRecord);
    await objectStorageAdapter.put("images/test-photo.jpg", jpegBuffer);

    const result = await IMAGE_DIMENSIONS_GENERATOR.generate(
      { dataRecordId: dataRecord.id, dependencyIds: [], parameters: {} },
      context,
    );

    expect(result.value).toEqual({ width: 1024, height: 768, format: "jpeg" });
  });

  it("should return zeros for missing object storage key", async () => {
    const clock = createHLCClock({ nodeId: "test-node", wallClockFunction: () => 1000 });
    const dataRecord = createDataRecord(
      {
        type: "@starkeep/photo",
        ownerId: "test-owner",
      },
      clock,
    );

    await databaseAdapter.put(dataRecord);

    const result = await IMAGE_DIMENSIONS_GENERATOR.generate(
      { dataRecordId: dataRecord.id, dependencyIds: [], parameters: {} },
      context,
    );

    expect(result.value).toEqual({ width: 0, height: 0, format: "unknown" });
  });

  it("should return zeros for unrecognized format", async () => {
    const clock = createHLCClock({ nodeId: "test-node", wallClockFunction: () => 1000 });
    const dataRecord = createDataRecord(
      {
        type: "@starkeep/photo",
        ownerId: "test-owner",
        objectStorageKey: "images/test-file.bmp",
      },
      clock,
    );

    await databaseAdapter.put(dataRecord);
    await objectStorageAdapter.put("images/test-file.bmp", Buffer.from([0x42, 0x4d, 0x00, 0x00]));

    const result = await IMAGE_DIMENSIONS_GENERATOR.generate(
      { dataRecordId: dataRecord.id, dependencyIds: [], parameters: {} },
      context,
    );

    expect(result.value).toEqual({ width: 0, height: 0, format: "unknown" });
  });
});

describe("FILE_PROPERTIES_GENERATOR", () => {
  let databaseAdapter: MockDatabaseAdapter;
  let objectStorageAdapter: MockObjectStorageAdapter;
  let context: GenerationContext;

  beforeEach(async () => {
    databaseAdapter = new MockDatabaseAdapter();
    objectStorageAdapter = new MockObjectStorageAdapter();
    context = createTestContext(databaseAdapter, objectStorageAdapter);
    await databaseAdapter.init();
    await objectStorageAdapter.init();
  });

  it("should have correct generator metadata", () => {
    expect(FILE_PROPERTIES_GENERATOR.generatorId).toBe("@starkeep/metadata-core:file-properties");
    expect(FILE_PROPERTIES_GENERATOR.generatorVersion).toBe(1);
    expect(FILE_PROPERTIES_GENERATOR.inputTypes).toEqual(["*"]);
    expect(FILE_PROPERTIES_GENERATOR.dependsOn).toEqual([]);
  });

  it("should extract file properties from a data record", async () => {
    const clock = createHLCClock({ nodeId: "test-node", wallClockFunction: () => 1000 });
    const dataRecord = createDataRecord(
      {
        type: "@starkeep/photo",
        ownerId: "test-owner",
        sizeBytes: 1048576,
        mimeType: "image/png",
        contentHash: "sha256-abc123def456",
      },
      clock,
    );

    await databaseAdapter.put(dataRecord);

    const result = await FILE_PROPERTIES_GENERATOR.generate(
      { dataRecordId: dataRecord.id, dependencyIds: [], parameters: {} },
      context,
    );

    expect(result.value).toEqual({
      sizeBytes: 1048576,
      mimeType: "image/png",
      contentHash: "sha256-abc123def456",
    });
  });

  it("should return nulls when record is not found", async () => {
    const nonexistentId = createStarkeepId("01ARZ3NDEKTSV4RRFFQ69G5FAV");

    const result = await FILE_PROPERTIES_GENERATOR.generate(
      { dataRecordId: nonexistentId, dependencyIds: [], parameters: {} },
      context,
    );

    expect(result.value).toEqual({
      sizeBytes: null,
      mimeType: null,
      contentHash: null,
    });
  });
});

describe("TEXT_PREVIEW_GENERATOR", () => {
  let databaseAdapter: MockDatabaseAdapter;
  let objectStorageAdapter: MockObjectStorageAdapter;
  let context: GenerationContext;

  beforeEach(async () => {
    databaseAdapter = new MockDatabaseAdapter();
    objectStorageAdapter = new MockObjectStorageAdapter();
    context = createTestContext(databaseAdapter, objectStorageAdapter);
    await databaseAdapter.init();
    await objectStorageAdapter.init();
  });

  it("should have correct generator metadata", () => {
    expect(TEXT_PREVIEW_GENERATOR.generatorId).toBe("@starkeep/metadata-core:text-preview");
    expect(TEXT_PREVIEW_GENERATOR.generatorVersion).toBe(1);
    expect(TEXT_PREVIEW_GENERATOR.inputTypes).toEqual(["@starkeep/document", "@starkeep/note"]);
    expect(TEXT_PREVIEW_GENERATOR.dependsOn).toEqual([]);
  });

  it("should generate a text preview from object storage", async () => {
    const clock = createHLCClock({ nodeId: "test-node", wallClockFunction: () => 1000 });
    const textContent = "This is a sample document with some text content for preview generation.";
    const dataRecord = createDataRecord(
      {
        type: "@starkeep/document",
        ownerId: "test-owner",
        objectStorageKey: "documents/sample.txt",
      },
      clock,
    );

    await databaseAdapter.put(dataRecord);
    await objectStorageAdapter.put("documents/sample.txt", Buffer.from(textContent, "utf-8"));

    const result = await TEXT_PREVIEW_GENERATOR.generate(
      { dataRecordId: dataRecord.id, dependencyIds: [], parameters: {} },
      context,
    );

    expect(result.value.preview).toBe(textContent);
    expect(result.value.characterCount).toBe(textContent.length);
  });

  it("should truncate at last space boundary when text exceeds 500 characters", async () => {
    const clock = createHLCClock({ nodeId: "test-node", wallClockFunction: () => 1000 });
    const longText = "word ".repeat(200); // 1000 characters
    const dataRecord = createDataRecord(
      {
        type: "@starkeep/note",
        ownerId: "test-owner",
        objectStorageKey: "notes/long-note.txt",
      },
      clock,
    );

    await databaseAdapter.put(dataRecord);
    await objectStorageAdapter.put("notes/long-note.txt", Buffer.from(longText, "utf-8"));

    const result = await TEXT_PREVIEW_GENERATOR.generate(
      { dataRecordId: dataRecord.id, dependencyIds: [], parameters: {} },
      context,
    );

    expect((result.value.preview as string).length).toBeLessThanOrEqual(500);
    expect(result.value.preview).toBe("word ".repeat(100));
  });

  it("should fall back to payload content when no object storage key", async () => {
    const clock = createHLCClock({ nodeId: "test-node", wallClockFunction: () => 1000 });
    const payloadContent = "Inline note content from the payload field.";
    const dataRecord = createDataRecord(
      {
        type: "@starkeep/note",
        ownerId: "test-owner",
        payload: { content: payloadContent },
      },
      clock,
    );

    await databaseAdapter.put(dataRecord);

    const result = await TEXT_PREVIEW_GENERATOR.generate(
      { dataRecordId: dataRecord.id, dependencyIds: [], parameters: {} },
      context,
    );

    expect(result.value.preview).toBe(payloadContent);
    expect(result.value.characterCount).toBe(payloadContent.length);
  });

  it("should return empty preview when no content available", async () => {
    const clock = createHLCClock({ nodeId: "test-node", wallClockFunction: () => 1000 });
    const dataRecord = createDataRecord(
      {
        type: "@starkeep/note",
        ownerId: "test-owner",
      },
      clock,
    );

    await databaseAdapter.put(dataRecord);

    const result = await TEXT_PREVIEW_GENERATOR.generate(
      { dataRecordId: dataRecord.id, dependencyIds: [], parameters: {} },
      context,
    );

    expect(result.value).toEqual({ preview: "", characterCount: 0 });
  });
});

describe("registerCoreMetadataGenerators", () => {
  it("should register all three generators in the registry and dependency graph", () => {
    const registry = createGeneratorRegistry();
    const dependencyGraph = createDependencyGraph();

    registerCoreMetadataGenerators(registry, dependencyGraph);

    const allGenerators = registry.list();
    expect(allGenerators).toHaveLength(3);

    const generatorIds = allGenerators.map((generator) => generator.generatorId).sort();
    expect(generatorIds).toEqual([
      "@starkeep/metadata-core:file-properties",
      "@starkeep/metadata-core:image-dimensions",
      "@starkeep/metadata-core:text-preview",
    ]);

    expect(registry.get("@starkeep/metadata-core:image-dimensions")).toBeDefined();
    expect(registry.get("@starkeep/metadata-core:file-properties")).toBeDefined();
    expect(registry.get("@starkeep/metadata-core:text-preview")).toBeDefined();
  });

  it("should add generators to the dependency graph without cycles", () => {
    const registry = createGeneratorRegistry();
    const dependencyGraph = createDependencyGraph();

    registerCoreMetadataGenerators(registry, dependencyGraph);

    expect(dependencyGraph.hasCycle()).toBe(false);
  });
});
