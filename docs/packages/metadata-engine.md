# @starkeep/metadata-engine

Orchestrates metadata generation: manages a registry of generators, resolves dependencies
between them, and generates or refreshes metadata records on demand or via a queue.

You interact with this package through the SDK (`sdk.metadata`). Import directly only if
you need fine-grained control over generation behavior.

## What it does

When you call `sdk.metadata.generateAll(recordId, type)`, the engine:

1. Looks up all generators registered for that record type
2. Builds an execution order from the generator dependency graph
3. For each generator, checks whether existing metadata is still fresh (via input hashing)
4. Runs any stale or missing generators
5. Stores the resulting metadata records

## Defining a generator

```typescript
import type { GeneratingFunctionDefinition } from "@starkeep/metadata-engine"

const myGenerator: GeneratingFunctionDefinition = {
  generatorId: "my-app:word-count",
  generatorVersion: 1,
  inputTypes: ["documents:doc"],   // record types this handles; use ["*"] for all types
  dependsOn: [],                   // generatorIds this must run after

  async generate(input, context) {
    const record = await context.databaseAdapter.get(input.dataRecordId)
    const words = (record?.payload?.content as string ?? "").split(/\s+/).length
    return { value: { wordCount: words } }
  },
}
```

Pass generators to `createStarkeepSdk({ generators: [...] })` and the engine handles
the rest.

## Generator dependencies

A generator can declare that it depends on the output of other generators. The engine
builds a topological sort to ensure upstream generators run first. Circular dependencies
are detected at registration time and throw a `CyclicDependencyError`.

## Staleness detection

Each metadata record stores a hash of the inputs it was computed from. Before running a
generator, the engine recomputes the hash and compares it to the stored one. If the inputs
haven't changed, the cached result is returned without re-running the generator.

## Migrations

When a generator's output schema changes, declare a migration to update existing metadata
records:

```typescript
const migration: MetadataMigration = {
  generatorId: "my-app:word-count",
  fromVersion: 1,
  toVersion: 2,
  migrate(existingValue) {
    return { ...existingValue, characterCount: 0 }  // add a new field
  },
}
```

## API

```typescript
import {
  createMetadataEngine,
  createGeneratorRegistry,
  createDependencyGraph,
  createGenerationQueue,
  createMigrationRunner,
  computeInputHash,
} from "@starkeep/metadata-engine"
```

See [Reference](../reference.md) for full type signatures.
