import type { GeneratorRegistry, GeneratingFunctionDefinition } from "./types.js";
import { MetadataEngineError } from "./errors.js";

export function createGeneratorRegistry(): GeneratorRegistry {
  const generators = new Map<string, GeneratingFunctionDefinition>();

  return {
    register(definition: GeneratingFunctionDefinition): void {
      if (generators.has(definition.generatorId)) {
        throw new MetadataEngineError(
          `Generator "${definition.generatorId}" is already registered`,
        );
      }
      generators.set(definition.generatorId, definition);
    },

    get(generatorId: string): GeneratingFunctionDefinition | undefined {
      return generators.get(generatorId);
    },

    getForType(dataType: string): GeneratingFunctionDefinition[] {
      return Array.from(generators.values()).filter((definition) =>
        definition.inputTypes.includes(dataType),
      );
    },

    list(): GeneratingFunctionDefinition[] {
      return Array.from(generators.values());
    },
  };
}
