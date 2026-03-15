import { describe, it, expect } from "vitest";
import { createGeneratorRegistry } from "../src/generator-registry.js";
import type { GeneratingFunctionDefinition } from "../src/types.js";

function createTestGenerator(
  overrides: Partial<GeneratingFunctionDefinition> = {},
): GeneratingFunctionDefinition {
  return {
    generatorId: "@test:dimensions",
    generatorVersion: 1,
    inputTypes: ["@test/photo"],
    dependsOn: [],
    generate: async () => ({ value: {} }),
    ...overrides,
  };
}

describe("createGeneratorRegistry", () => {
  it("should register and retrieve a generator", () => {
    const registry = createGeneratorRegistry();
    const generator = createTestGenerator();
    registry.register(generator);

    expect(registry.get("@test:dimensions")).toBe(generator);
  });

  it("should return undefined for unregistered generator", () => {
    const registry = createGeneratorRegistry();

    expect(registry.get("@test:nonexistent")).toBeUndefined();
  });

  it("should throw on duplicate registration", () => {
    const registry = createGeneratorRegistry();
    const generator = createTestGenerator();
    registry.register(generator);

    expect(() => registry.register(generator)).toThrow("already registered");
  });

  it("should get generators for a data type", () => {
    const registry = createGeneratorRegistry();
    registry.register(createTestGenerator({ generatorId: "@test:dims" }));
    registry.register(
      createTestGenerator({
        generatorId: "@test:thumb",
        inputTypes: ["@test/photo"],
      }),
    );
    registry.register(
      createTestGenerator({
        generatorId: "@test:text",
        inputTypes: ["@test/document"],
      }),
    );

    const photoGenerators = registry.getForType("@test/photo");
    expect(photoGenerators).toHaveLength(2);

    const documentGenerators = registry.getForType("@test/document");
    expect(documentGenerators).toHaveLength(1);
  });

  it("should list all generators", () => {
    const registry = createGeneratorRegistry();
    registry.register(createTestGenerator({ generatorId: "@test:a" }));
    registry.register(createTestGenerator({ generatorId: "@test:b" }));

    expect(registry.list()).toHaveLength(2);
  });
});
