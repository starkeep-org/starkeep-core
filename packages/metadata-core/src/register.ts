import type { GeneratorRegistry, DependencyGraph } from "@starkeep/metadata-engine";
import { IMAGE_DIMENSIONS_GENERATOR } from "./generators/image-dimensions.js";
import { FILE_PROPERTIES_GENERATOR } from "./generators/file-properties.js";
import { TEXT_PREVIEW_GENERATOR } from "./generators/text-preview.js";

export function registerCoreMetadataGenerators(
  registry: GeneratorRegistry,
  dependencyGraph: DependencyGraph,
): void {
  const generators = [
    IMAGE_DIMENSIONS_GENERATOR,
    FILE_PROPERTIES_GENERATOR,
    TEXT_PREVIEW_GENERATOR,
  ];

  for (const generator of generators) {
    registry.register(generator);
    dependencyGraph.addGenerator(generator);
  }
}
