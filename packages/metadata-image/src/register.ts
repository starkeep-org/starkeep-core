import type { GeneratorRegistry, DependencyGraph } from "@starkeep/metadata-engine";
import { STANDARD_DOWNSIZE_GENERATORS } from "./index.js";

export function registerImageDownsizeGenerators(
  registry: GeneratorRegistry,
  dependencyGraph: DependencyGraph,
): void {
  for (const generator of STANDARD_DOWNSIZE_GENERATORS) {
    registry.register(generator);
    dependencyGraph.addGenerator(generator);
  }
}
