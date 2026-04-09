# @starkeep/core

Protocol foundations shared by every other package: identifiers, HLC timestamps, record
types, the type registry, validation, and error types.

You rarely import from `@starkeep/core` directly in application code — the SDK re-exports
what you need. Import directly when building a protocol package or writing low-level
infrastructure.

## Identifiers

All records are identified by a **StarkeepId** — a branded `string` wrapping a 26-character
ULID. ULIDs encode a millisecond timestamp followed by random bits, so they sort
lexicographically in creation order and are globally unique without coordination.

```typescript
import { generateId, generateIdAt, createStarkeepId, isStarkeepId } from "@starkeep/core"

const id = generateId()                    // new ULID
const id2 = generateIdAt(Date.now())       // ULID at a specific timestamp
const id3 = createStarkeepId("existing")  // brand an existing string
isStarkeepId(id)                           // true
```

## HLC timestamps

Every mutation is timestamped with a **Hybrid Logical Clock**. An HLC timestamp has three
components: physical wall time (milliseconds), a logical counter for events at the same
millisecond, and a node identifier. Together they provide a total, deterministic ordering
over all events across all devices.

```typescript
import { createHLCClock, compareHLC, maxHLC, serializeHLC, deserializeHLC } from "@starkeep/core"

const clock = createHLCClock({ nodeId: "device-abc" })

const ts = clock.now()    // current timestamp
clock.send()              // timestamp for an outgoing event (advances counter)
clock.receive(remote)     // merge a remote timestamp into local clock

compareHLC(a, b)          // -1 | 0 | 1
maxHLC(a, b)              // the later of two timestamps
serializeHLC(ts)          // "wallTime:counter:nodeId"
deserializeHLC(str)       // parse back to HLCTimestamp
```

## Records

### Data records

Data records represent user content. Create them with `createDataRecord(input, clock)`:

```typescript
import { createDataRecord } from "@starkeep/core"

const record = createDataRecord(
  {
    type: "tasks:task",
    ownerId: "user-123",
    payload: { title: "Write docs", status: "todo" },
  },
  clock,
)
```

Optional file-backing fields: `contentHash`, `objectStorageKey`, `mimeType`, `sizeBytes`.

### Metadata records

Metadata records are created by generators, not directly by application code. The factory
`createMetadataRecord(input, clock)` is used internally by the metadata engine.

### Validation

```typescript
import { validateDataRecord, validateMetadataRecord, validateAnyRecord } from "@starkeep/core"

validateDataRecord(value)      // throws ValidationError if invalid
validateMetadataRecord(value)
validateAnyRecord(value)
```

## Type registry

All data and metadata types are registered in a central registry with namespace isolation.
Type keys take the form `namespace:name`.

```typescript
import { createTypeRegistry } from "@starkeep/core"
import * as v from "valibot"

const registry = createTypeRegistry()

registry.register({
  name: "task",
  namespace: "tasks",
  schema: v.object({ title: v.string(), status: v.string() }),
})

registry.get("tasks", "task")          // by namespace + name
registry.getByKey("tasks:task")        // by combined key
registry.has("tasks", "task")          // boolean
registry.list()                        // all registered types
```

## Error types

`StarkeepError` is the base class. See [Reference — Error hierarchy](../reference.md#error-hierarchy)
for the full tree.

```typescript
import { StarkeepError, ValidationError, NotFoundError, ConflictError } from "@starkeep/core"
```

## Result type

A lightweight `Result<T, E>` type for operations that can fail without throwing:

```typescript
import { ok, err, type Result } from "@starkeep/core"

const success = ok(value)     // Result<T, never>
const failure = err(error)    // Result<never, E>
```
