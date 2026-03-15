# @starkeep/metadata-engine

Metadata generation engine: register generators, resolve dependency order, hash inputs for cache invalidation, queue generation requests, and run metadata migrations.

## Installation

```bash
pnpm add @starkeep/metadata-engine
```

## Usage

```typescript
import {
  createGeneratorRegistry,
  createDependencyGraph,
  createGenerationQueue,
  createMetadataEngine,
  createMigrationRunner,
  computeInputHash,
} from "@starkeep/metadata-engine";
import type { GeneratingFunctionDefinition } from "@starkeep/metadata-engine";

// 1. Set up the registry and dependency graph
const registry = createGeneratorRegistry();
const dependencyGraph = createDependencyGraph();

// 2. Define a generator
const thumbnailGenerator: GeneratingFunctionDefinition = {
  generatorId: "app:thumbnail",
  generatorVersion: 1,
  inputTypes: ["@starkeep/photo"],
  dependsOn: [],
  async generate(input, context) {
    const record = await context.databaseAdapter.get(input.dataRecordId);
    // ... generate thumbnail ...
    return { value: { width: 128, height: 128 } };
  },
};

registry.register(thumbnailGenerator);
dependencyGraph.addGenerator(thumbnailGenerator);

// 3. Create the engine
const engine = createMetadataEngine({
  databaseAdapter,
  objectStorageAdapter,
  clock,
  ownerId: "user-123",
  generatorRegistry: registry,
  dependencyGraph,
});

// 4. Generate metadata for a single record
const result = await engine.generate({
  generatorId: "app:thumbnail",
  targetId: photoRecordId,
  mode: "on-demand",
});

// 5. Generate all applicable metadata for a record
const allResults = await engine.generateAll(photoRecordId, "@starkeep/photo");

// 6. Check staleness
const isStale = await engine.checkStaleness(metadataRecordId);

// 7. Use the queue for background processing
const generationQueue = createGenerationQueue();
generationQueue.enqueue({ generatorId: "app:thumbnail", targetId: photoRecordId, mode: "queued" });

// 8. Compute input hashes for cache invalidation
const hash = computeInputHash(input);
```

## API

### Factory Functions

| Export | Description |
|---|---|
| `createGeneratorRegistry()` | Create a `GeneratorRegistry` to register and look up generators |
| `createDependencyGraph()` | Create a `DependencyGraph` to resolve generation order and detect cycles |
| `createGenerationQueue()` | Create a priority-based `GenerationQueue` for background processing |
| `createMetadataEngine(options)` | Create the main `MetadataEngine` that orchestrates generation |
| `createMigrationRunner(options)` | Create a `MigrationRunner` for versioned metadata migrations |
| `computeInputHash(input)` | Compute a deterministic hash of generator inputs for cache comparison |

### Key Interfaces

| Type | Description |
|---|---|
| `GeneratingFunctionDefinition` | Generator definition: id, version, input types, dependencies, and generate function |
| `GenerationRequest` | Request to generate metadata: generator id, target id, mode, priority |
| `GenerationResult` | Result: the metadata record, whether it was stale, and whether it was cached |
| `GeneratorRegistry` | Register, retrieve, and list generators |
| `DependencyGraph` | Manage generator dependency order and cycle detection |
| `GenerationQueue` | Priority queue for generation requests |
| `MetadataEngine` | Generate metadata, generate all, check staleness |
| `MigrationRunner` | Register and apply versioned metadata migrations |
| `GenerationContext` | Context passed to generators: adapters, clock, owner id |

### Error Types

| Export | Description |
|---|---|
| `MetadataEngineError` | Base error for the metadata engine |
| `GenerationError` | Failure during metadata generation |
| `CyclicDependencyError` | Cycle detected in generator dependencies |
| `GeneratorNotFoundError` | Referenced generator does not exist |

## Testing

```bash
pnpm --filter @starkeep/metadata-engine test
```
