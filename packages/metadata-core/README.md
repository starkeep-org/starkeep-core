# @starkeep/metadata-core

Built-in metadata generators for common use cases: image dimensions, file properties, and text previews. Registers them into a `@starkeep/metadata-engine` registry in one call.

## Installation

```bash
pnpm add @starkeep/metadata-core
```

## Usage

```typescript
import { createGeneratorRegistry, createDependencyGraph } from "@starkeep/metadata-engine";
import { registerCoreMetadataGenerators } from "@starkeep/metadata-core";

const registry = createGeneratorRegistry();
const dependencyGraph = createDependencyGraph();

// Register all built-in generators at once
registerCoreMetadataGenerators(registry, dependencyGraph);

// Or import individual generators
import {
  IMAGE_DIMENSIONS_GENERATOR,
  FILE_PROPERTIES_GENERATOR,
  TEXT_PREVIEW_GENERATOR,
} from "@starkeep/metadata-core";

registry.register(IMAGE_DIMENSIONS_GENERATOR);
dependencyGraph.addGenerator(IMAGE_DIMENSIONS_GENERATOR);
```

## Generators

### `IMAGE_DIMENSIONS_GENERATOR`

- **Id:** `@starkeep/metadata-core:image-dimensions`
- **Input types:** `@starkeep/photo`, `@starkeep/image`
- **Output:** `{ width, height, format }` -- parses PNG and JPEG headers from object storage

### `FILE_PROPERTIES_GENERATOR`

- **Id:** `@starkeep/metadata-core:file-properties`
- **Input types:** `*` (all data record types)
- **Output:** `{ sizeBytes, mimeType, contentHash }` -- extracted from the data record fields

### `TEXT_PREVIEW_GENERATOR`

- **Id:** `@starkeep/metadata-core:text-preview`
- **Input types:** `@starkeep/document`, `@starkeep/note`
- **Output:** `{ preview, characterCount }` -- first 500 bytes of text content, truncated at a word boundary

## API

| Export | Description |
|---|---|
| `registerCoreMetadataGenerators(registry, dependencyGraph)` | Register all built-in generators into a registry and dependency graph |
| `IMAGE_DIMENSIONS_GENERATOR` | Generator definition for image width/height/format extraction |
| `FILE_PROPERTIES_GENERATOR` | Generator definition for file size, MIME type, and content hash |
| `TEXT_PREVIEW_GENERATOR` | Generator definition for text content preview |

## Testing

```bash
pnpm --filter @starkeep/metadata-core test
```
