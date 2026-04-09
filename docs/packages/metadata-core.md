# @starkeep/metadata-core

Built-in metadata generators for common file types. Register them when creating the SDK
to get automatic metadata extraction for images, files, and text.

## Generators

| Generator | ID | Handles | Output fields |
|-----------|-----|---------|--------------|
| `IMAGE_DIMENSIONS_GENERATOR` | `image-dimensions` | JPEG, PNG, WebP, GIF | `width`, `height`, `format` |
| `FILE_PROPERTIES_GENERATOR` | `file-properties` | All file-backed records | `extension`, `mimeType`, `sizeBytes` |
| `TEXT_PREVIEW_GENERATOR` | `text-preview` | Plain text, Markdown, JSON | `preview`, `totalLines`, `characterCount` |

## Usage

```typescript
import {
  IMAGE_DIMENSIONS_GENERATOR,
  FILE_PROPERTIES_GENERATOR,
  TEXT_PREVIEW_GENERATOR,
  registerCoreMetadataGenerators,
} from "@starkeep/metadata-core"
import { createGeneratorRegistry } from "@starkeep/metadata-engine"

// Register all three at once
const registry = createGeneratorRegistry()
registerCoreMetadataGenerators(registry)

// Or pass them individually to the SDK
const sdk = await createStarkeepSdk({
  // ...
  generators: [
    IMAGE_DIMENSIONS_GENERATOR,
    FILE_PROPERTIES_GENERATOR,
    TEXT_PREVIEW_GENERATOR,
  ],
})
```

## Notes

- `FILE_PROPERTIES_GENERATOR` applies to all file-backed records (those with a `contentHash`),
  regardless of MIME type
- `IMAGE_DIMENSIONS_GENERATOR` only runs on records whose MIME type is one of the supported
  image formats; it is skipped for other types
- You can use these alongside custom generators — they are regular
  `GeneratingFunctionDefinition` objects
