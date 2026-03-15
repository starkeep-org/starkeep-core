import { describe, it, expect } from "vitest";
import { createDependencyGraph } from "../src/dependency-graph.js";
import { CyclicDependencyError } from "../src/errors.js";
import type { GeneratingFunctionDefinition } from "../src/types.js";

function createTestGenerator(
  generatorId: string,
  inputTypes: string[] = ["@test/photo"],
  dependsOn: string[] = [],
): GeneratingFunctionDefinition {
  return {
    generatorId,
    generatorVersion: 1,
    inputTypes,
    dependsOn,
    generate: async () => ({ value: {} }),
  };
}

describe("createDependencyGraph", () => {
  it("should return generation order for independent generators", () => {
    const graph = createDependencyGraph();
    graph.addGenerator(createTestGenerator("@test:dims"));
    graph.addGenerator(createTestGenerator("@test:hash"));

    const order = graph.getGenerationOrder("@test/photo");
    expect(order).toHaveLength(2);
    expect(order).toContain("@test:dims");
    expect(order).toContain("@test:hash");
  });

  it("should respect dependency order", () => {
    const graph = createDependencyGraph();
    graph.addGenerator(createTestGenerator("@test:dims"));
    graph.addGenerator(
      createTestGenerator("@test:thumb", ["@test/photo"], ["@test:dims"]),
    );

    const order = graph.getGenerationOrder("@test/photo");
    expect(order.indexOf("@test:dims")).toBeLessThan(
      order.indexOf("@test:thumb"),
    );
  });

  it("should handle multi-level dependencies", () => {
    const graph = createDependencyGraph();
    graph.addGenerator(createTestGenerator("@test:dims"));
    graph.addGenerator(
      createTestGenerator("@test:thumb", ["@test/photo"], ["@test:dims"]),
    );
    graph.addGenerator(
      createTestGenerator("@test:gallery", ["@test/photo"], ["@test:thumb"]),
    );

    const order = graph.getGenerationOrder("@test/photo");
    expect(order.indexOf("@test:dims")).toBeLessThan(
      order.indexOf("@test:thumb"),
    );
    expect(order.indexOf("@test:thumb")).toBeLessThan(
      order.indexOf("@test:gallery"),
    );
  });

  it("should detect cycles", () => {
    const graph = createDependencyGraph();
    graph.addGenerator(
      createTestGenerator("@test:a", ["@test/photo"], ["@test:b"]),
    );
    graph.addGenerator(
      createTestGenerator("@test:b", ["@test/photo"], ["@test:a"]),
    );

    expect(graph.hasCycle()).toBe(true);
    expect(() => graph.getGenerationOrder("@test/photo")).toThrow(
      CyclicDependencyError,
    );
  });

  it("should report no cycle for acyclic graph", () => {
    const graph = createDependencyGraph();
    graph.addGenerator(createTestGenerator("@test:a"));
    graph.addGenerator(
      createTestGenerator("@test:b", ["@test/photo"], ["@test:a"]),
    );

    expect(graph.hasCycle()).toBe(false);
  });

  it("should get dependents of a generator", () => {
    const graph = createDependencyGraph();
    graph.addGenerator(createTestGenerator("@test:dims"));
    graph.addGenerator(
      createTestGenerator("@test:thumb", ["@test/photo"], ["@test:dims"]),
    );
    graph.addGenerator(
      createTestGenerator("@test:crop", ["@test/photo"], ["@test:dims"]),
    );

    const dependents = graph.getDependents("@test:dims");
    expect(dependents).toHaveLength(2);
    expect(dependents).toContain("@test:thumb");
    expect(dependents).toContain("@test:crop");
  });

  it("should get dependencies of a generator", () => {
    const graph = createDependencyGraph();
    graph.addGenerator(createTestGenerator("@test:dims"));
    graph.addGenerator(createTestGenerator("@test:hash"));
    graph.addGenerator(
      createTestGenerator("@test:thumb", ["@test/photo"], [
        "@test:dims",
        "@test:hash",
      ]),
    );

    const dependencies = graph.getDependencies("@test:thumb");
    expect(dependencies).toHaveLength(2);
    expect(dependencies).toContain("@test:dims");
    expect(dependencies).toContain("@test:hash");
  });

  it("should only include relevant generators for a data type", () => {
    const graph = createDependencyGraph();
    graph.addGenerator(createTestGenerator("@test:dims", ["@test/photo"]));
    graph.addGenerator(
      createTestGenerator("@test:text-preview", ["@test/document"]),
    );

    const photoOrder = graph.getGenerationOrder("@test/photo");
    expect(photoOrder).toEqual(["@test:dims"]);

    const documentOrder = graph.getGenerationOrder("@test/document");
    expect(documentOrder).toEqual(["@test:text-preview"]);
  });
});
