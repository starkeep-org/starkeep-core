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
5. Stores the resulting metadata into the per-type metadata table via `putMetadata`

## Defining a generator

```typescript
import type { GeneratingFunctionDefinition } from "@starkeep/metadata-engine"

const myGenerator: GeneratingFunctionDefinition = {
  generatorId: "my-app:word-count",
  generatorVersion: 1,
  inputTypes: ["documents:doc"],   // record types this handles; use ["*"] for all types
  dependsOn: [],                   // generatorIds this must run after
  outputColumns: [
    { name: "word_count", columnType: "integer" },
  ],

  async generate(input, context) {
    const record = await context.databaseAdapter.get(input.dataRecordId)
    const fileResult = await context.objectStorageAdapter.get(record!.objectStorageKey!)
    const text = new TextDecoder().decode(fileResult!.data)
    return { value: { wordCount: text.split(/\s+/).length } }
  },
}
```

`outputColumns` declares the SQL columns this generator writes into the per-type metadata
table. Column names are `snake_case`; the corresponding keys in `generate`'s return value
use `camelCase` (e.g., `"word_count"` ↔ `wordCount`).

Pass generators to `createStarkeepSdk({ generators: [...] })` and the SDK calls
`ensureMetadataTable` for each generator at init, then the engine handles generation.

## Generator input

The `generate` function receives:

```typescript
interface GeneratingFunctionInput {
  dataRecordId: StarkeepId;   // the target data record
  targetType: string;          // the type of the target record (e.g. "tasks:task")
  dependencyIds: string[];     // input hashes of dependency generators' outputs
  parameters: Record<string, unknown>;
}
```

Use `context.databaseAdapter.queryMetadata(input.targetType, { targetId: ..., generatorId: ... })`
to read previously generated metadata from within a generator.

## Generator dependencies

A generator can declare that it depends on the output of other generators. The engine
builds a topological sort to ensure upstream generators run first. Circular dependencies
are detected at registration time and throw a `CyclicDependencyError`.

## Staleness detection

Each metadata row stores per-generator `input_hash` and `generator_version` columns.
Before running a generator, the engine recomputes the hash and compares it to the stored
one. If the inputs haven't changed, the cached result is returned without re-running.

## Migrations

When a generator's output schema changes, declare a migration to update existing metadata:

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

Call `migrationRunner.applyPendingMigrations(generatorId, targetType)` to apply pending
migrations for a generator across all records of that type.

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
