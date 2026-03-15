import { StarkeepError } from "@starkeep/core";

export class MetadataEngineError extends StarkeepError {
  constructor(message: string, cause?: unknown) {
    super(message, "METADATA_ENGINE_ERROR", cause);
    this.name = "MetadataEngineError";
  }
}

export class GenerationError extends StarkeepError {
  constructor(
    message: string,
    public readonly generatorId: string,
    cause?: unknown,
  ) {
    super(message, "GENERATION_ERROR", cause);
    this.name = "GenerationError";
  }
}

export class CyclicDependencyError extends StarkeepError {
  constructor(generatorIds: string[]) {
    super(
      `Cyclic dependency detected among generators: ${generatorIds.join(" -> ")}`,
      "CYCLIC_DEPENDENCY",
    );
    this.name = "CyclicDependencyError";
  }
}

export class GeneratorNotFoundError extends StarkeepError {
  constructor(generatorId: string) {
    super(`Generator not found: ${generatorId}`, "GENERATOR_NOT_FOUND");
    this.name = "GeneratorNotFoundError";
  }
}
