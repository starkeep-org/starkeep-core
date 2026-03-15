import type { DependencyGraph, GeneratingFunctionDefinition } from "./types.js";
import { CyclicDependencyError } from "./errors.js";

export function createDependencyGraph(): DependencyGraph {
  const generators = new Map<string, GeneratingFunctionDefinition>();
  const adjacency = new Map<string, Set<string>>();
  const reverseAdjacency = new Map<string, Set<string>>();

  function ensureNode(generatorId: string): void {
    if (!adjacency.has(generatorId)) {
      adjacency.set(generatorId, new Set());
    }
    if (!reverseAdjacency.has(generatorId)) {
      reverseAdjacency.set(generatorId, new Set());
    }
  }

  return {
    addGenerator(definition: GeneratingFunctionDefinition): void {
      generators.set(definition.generatorId, definition);
      ensureNode(definition.generatorId);

      for (const dependency of definition.dependsOn) {
        ensureNode(dependency);
        adjacency.get(definition.generatorId)!.add(dependency);
        reverseAdjacency.get(dependency)!.add(definition.generatorId);
      }
    },

    getGenerationOrder(dataType: string): string[] {
      const relevant = new Set<string>();

      for (const [generatorId, definition] of generators) {
        if (definition.inputTypes.includes(dataType)) {
          relevant.add(generatorId);
          const stack = [...definition.dependsOn];
          while (stack.length > 0) {
            const dependency = stack.pop()!;
            if (!relevant.has(dependency) && generators.has(dependency)) {
              relevant.add(dependency);
              const dependencyDefinition = generators.get(dependency)!;
              stack.push(...dependencyDefinition.dependsOn);
            }
          }
        }
      }

      // Kahn's algorithm for topological sort
      const inDegree = new Map<string, number>();
      for (const generatorId of relevant) {
        inDegree.set(generatorId, 0);
      }
      for (const generatorId of relevant) {
        for (const dependency of adjacency.get(generatorId) ?? []) {
          if (relevant.has(dependency)) {
            inDegree.set(generatorId, (inDegree.get(generatorId) ?? 0) + 1);
          }
        }
      }

      const queue: string[] = [];
      for (const [generatorId, degree] of inDegree) {
        if (degree === 0) {
          queue.push(generatorId);
        }
      }

      const sorted: string[] = [];
      while (queue.length > 0) {
        const current = queue.shift()!;
        sorted.push(current);

        for (const dependent of reverseAdjacency.get(current) ?? []) {
          if (relevant.has(dependent)) {
            const newDegree = (inDegree.get(dependent) ?? 1) - 1;
            inDegree.set(dependent, newDegree);
            if (newDegree === 0) {
              queue.push(dependent);
            }
          }
        }
      }

      if (sorted.length < relevant.size) {
        const unsorted = [...relevant].filter(
          (generatorId) => !sorted.includes(generatorId),
        );
        throw new CyclicDependencyError(unsorted);
      }

      return sorted;
    },

    getDependents(generatorId: string): string[] {
      return Array.from(reverseAdjacency.get(generatorId) ?? []);
    },

    getDependencies(generatorId: string): string[] {
      return Array.from(adjacency.get(generatorId) ?? []);
    },

    hasCycle(): boolean {
      const visited = new Set<string>();
      const recursionStack = new Set<string>();

      function depthFirstSearch(node: string): boolean {
        visited.add(node);
        recursionStack.add(node);

        for (const neighbor of adjacency.get(node) ?? []) {
          if (!visited.has(neighbor)) {
            if (depthFirstSearch(neighbor)) return true;
          } else if (recursionStack.has(neighbor)) {
            return true;
          }
        }

        recursionStack.delete(node);
        return false;
      }

      for (const node of adjacency.keys()) {
        if (!visited.has(node)) {
          if (depthFirstSearch(node)) return true;
        }
      }

      return false;
    },
  };
}
