# @starkeep/core

Protocol core for Starkeep: ULID-based identifiers, hybrid logical clocks (HLC), record builders, schema validation (valibot), and a type registry.

## Installation

```bash
pnpm add @starkeep/core
```

## Usage

```typescript
import {
  generateId,
  createHLCClock,
  createDataRecord,
  createTypeRegistry,
  validateDataRecord,
} from "@starkeep/core";

// Generate a ULID-based identifier
const identifier = generateId();

// Create an HLC clock for ordering events
const clock = createHLCClock({ nodeId: "node-1" });
const timestamp = clock.now();

// Build a data record
const record = createDataRecord({
  type: "photo",
  ownerId: "user-123",
  clock,
  payload: { title: "Sunset" },
  mimeType: "image/jpeg",
  sizeBytes: 204800,
});

// Validate a record against the schema
const validationResult = validateDataRecord(record);

// Register custom types
const registry = createTypeRegistry();
registry.register({ name: "photo", kind: "data" });
```

## API

### Identifiers

| Export | Description |
|---|---|
| `generateId()` | Generate a new ULID-based `StarkeepId` |
| `generateIdAt(timestamp)` | Generate a ULID seeded at a specific timestamp |
| `createStarkeepId(value)` | Wrap a raw string as a `StarkeepId` |
| `isStarkeepId(value)` | Type guard for `StarkeepId` |

### Hybrid Logical Clock

| Export | Description |
|---|---|
| `createHLCClock(options)` | Create an HLC clock instance |
| `compareHLC(a, b)` | Compare two HLC timestamps (-1, 0, 1) |
| `maxHLC(a, b)` | Return the greater of two HLC timestamps |
| `serializeHLC(timestamp)` | Serialize an HLC timestamp to a string |
| `deserializeHLC(value)` | Deserialize a string back to an HLC timestamp |

### Records

| Export | Description |
|---|---|
| `createDataRecord(input)` | Build a `DataRecord` with generated id and timestamps |
| `createMetadataRecord(input)` | Build a `MetadataRecord` linked to a data record |
| `SyncStatus` | Enum: `local`, `syncing`, `synced`, `conflict` |

### Schema & Validation

| Export | Description |
|---|---|
| `validateDataRecord(record)` | Validate a data record against the valibot schema |
| `validateMetadataRecord(record)` | Validate a metadata record |
| `validateAnyRecord(record)` | Validate any record (data or metadata) |
| `dataRecordSchema` | Valibot schema for data records |
| `metadataRecordSchema` | Valibot schema for metadata records |
| `createTypeRegistry()` | Create a registry for custom type definitions |

### Error Types

| Export | Description |
|---|---|
| `StarkeepError` | Base error class |
| `ValidationError` | Schema validation failure |
| `NotFoundError` | Record not found |
| `ConflictError` | Conflicting record state |

### Utilities

| Export | Description |
|---|---|
| `ok(value)` | Wrap a value in a success `Result` |
| `err(error)` | Wrap an error in a failure `Result` |

## Testing

```bash
pnpm --filter @starkeep/core test
```
