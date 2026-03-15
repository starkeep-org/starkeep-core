# Data Protocol Specification

## 1. Identifiers

All entities in the protocol are identified by **StarkeepId**, a branded string type wrapping a 26-character ULID.

```typescript
type StarkeepId = string & { readonly __brand: "StarkeepId" }
```

ULIDs encode a 48-bit millisecond timestamp followed by 80 bits of randomness, providing:
- Globally unique identifiers without coordination
- Lexicographic sorting by creation time
- Monotonic generation within the same millisecond (via the `ulidx` library)

### Operations

| Function | Description |
|----------|-------------|
| `generateId()` | Generate a new monotonic ULID |
| `generateIdAt(timestamp)` | Generate a ULID at a specific timestamp |
| `createStarkeepId(value)` | Brand an existing string as a StarkeepId |
| `isStarkeepId(value)` | Type guard predicate |

## 2. Hybrid Logical Clocks

Every mutation in the protocol is timestamped with an HLC. An HLC timestamp is a triple:

```typescript
interface HLCTimestamp {
  wallTime: number   // Physical clock (ms since epoch)
  counter: number    // Logical counter
  nodeId: string     // Node identifier
}
```

### Clock operations

| Operation | Behavior |
|-----------|----------|
| `now()` | Returns current HLC timestamp |
| `send()` | Advances clock and returns timestamp for outgoing messages |
| `receive(remote)` | Merges remote timestamp, advancing local clock |

### Comparison

`compareHLC(a, b)` returns `-1 | 0 | 1` using this ordering:
1. Higher `wallTime` wins
2. If equal, higher `counter` wins
3. If still equal, lexicographic `nodeId` comparison

This provides a **total order** over all events across all nodes.

### Serialization

HLC timestamps serialize to `"wallTime:counter:nodeId"` strings for storage and transmission.

### Factory

```typescript
const clock = createHLCClock({
  nodeId: "device-abc",
  wallClockFunction: () => Date.now(),  // optional, defaults to Date.now
})
```

## 3. Records

### Base fields

Every record shares these fields:

| Field | Type | Description |
|-------|------|-------------|
| `id` | `StarkeepId` | Unique identifier |
| `type` | `string` | Data type (namespaced) |
| `createdAt` | `HLCTimestamp` | Creation timestamp |
| `updatedAt` | `HLCTimestamp` | Last modification timestamp |
| `ownerId` | `string` | Owner identifier |
| `syncStatus` | `SyncStatus` | Current sync state |
| `deletedAt` | `HLCTimestamp \| null` | Soft delete timestamp |
| `version` | `number` | Monotonic version counter |

### Sync status

```
"local" ──> "pending_push" ──> "synced"
                                  │
                              "pending_pull"
                                  │
                              "conflict"
```

| Status | Meaning |
|--------|---------|
| `local` | Exists only locally, never synced |
| `synced` | In sync with remote |
| `pending_push` | Local changes not yet pushed |
| `pending_pull` | Remote changes not yet applied locally |
| `conflict` | Conflicting local and remote changes detected |

### Data records

Data records represent user content. They extend base fields with:

| Field | Type | Description |
|-------|------|-------------|
| `kind` | `"data"` | Discriminator |
| `contentHash` | `string \| null` | SHA-256 hash of file content |
| `objectStorageKey` | `string \| null` | Key in object storage |
| `mimeType` | `string \| null` | MIME type |
| `sizeBytes` | `number \| null` | File size |
| `payload` | `Record<string, unknown>` | Structured data |

A data record may be **file-backed** (a photo, document) or **record-only** (a conversation message, preference). File-backed records have `contentHash`, `objectStorageKey`, `mimeType`, and `sizeBytes` populated.

### Metadata records

Metadata records are derived from data records by generators. They extend base fields with:

| Field | Type | Description |
|-------|------|-------------|
| `kind` | `"metadata"` | Discriminator |
| `targetId` | `StarkeepId` | ID of the data record this describes |
| `generatorId` | `string` | Generator that produced this |
| `generatorVersion` | `number` | Version of the generator |
| `inputHash` | `string` | SHA-256 hash of generator inputs |
| `value` | `Record<string, unknown>` | Generated metadata content |

### Validation

Records are validated using valibot schemas:

```typescript
validateDataRecord(value)      // throws on invalid
validateMetadataRecord(value)  // throws on invalid
validateAnyRecord(value)       // validates either kind
```

## 4. Type Registry

Data and metadata types are registered in a global type registry with namespace isolation:

```typescript
const registry = createTypeRegistry()

registry.register({
  name: "photo",
  namespace: "photos",
  schema: v.object({ ... }),  // valibot schema
})

registry.get("photos", "photo")       // by namespace + name
registry.getByKey("photos:photo")     // by combined key
registry.has("photos", "photo")       // existence check
registry.list()                       // all registered types
```

Type keys follow the format `"namespace:name"` (e.g., `"photos:photo"`, `"ai:conversation"`).

## 5. Storage Abstraction

### Database adapter

The `DatabaseAdapter` interface defines all structured data operations:

```typescript
interface DatabaseAdapter {
  // Lifecycle
  init(): Promise<void>
  close(): Promise<void>
  healthCheck(): Promise<boolean>

  // CRUD
  put(record: AnyRecord): Promise<void>
  get(id: StarkeepId): Promise<AnyRecord | null>
  delete(id: StarkeepId): Promise<void>

  // Queries
  query(query: Query): Promise<QueryResult>

  // Batch and transactions
  batch(operations: BatchOperation[]): Promise<void>
  transaction<T>(callback: (transaction: Transaction) => Promise<T>): Promise<T>

  // Migrations
  runMigrations(migrations: Migration[]): Promise<void>
}
```

#### Query model

Queries support filtering, sorting, and cursor-based pagination:

```typescript
interface Query {
  type?: string                  // Filter by record type
  kind?: "data" | "metadata"    // Filter by kind
  filters?: Filter[]            // Field-level filters (AND logic)
  sort?: SortField[]            // Sort specifications
  limit?: number                // Result limit
  cursor?: string               // Pagination cursor
}
```

Filter operators: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in`, `like`

#### Implementations

| Adapter | Backend | Use case |
|---------|---------|----------|
| `SqliteDatabaseAdapter` | `node:sqlite` (Node.js 22+) | Local storage |
| `AuroraDsqlDatabaseAdapter` | Aurora DSQL (PostgreSQL) | Cloud storage |
| `MockDatabaseAdapter` | In-memory `Map` | Testing |

### Object storage adapter

The `ObjectStorageAdapter` interface defines file/blob operations:

```typescript
interface ObjectStorageAdapter {
  // Lifecycle
  init(): Promise<void>
  close(): Promise<void>
  healthCheck(): Promise<boolean>

  // Operations
  put(key: string, data: Buffer | Uint8Array, options?: PutOptions): Promise<void>
  get(key: string): Promise<GetResult | null>
  delete(key: string): Promise<void>
  list(prefix: string, options?: ListOptions): Promise<ListResult>

  // Optional
  getSignedUrl?(key: string, options?: SignedUrlOptions): Promise<string>
}
```

#### Implementations

| Adapter | Backend | Use case |
|---------|---------|----------|
| `FsObjectStorageAdapter` | Local filesystem | Local storage |
| `S3ObjectStorageAdapter` | AWS S3 | Cloud storage |
| `MockObjectStorageAdapter` | In-memory `Map` | Testing |

## 6. Metadata Generation

### Generator definition

A metadata generator declares what it operates on and produces:

```typescript
interface GeneratingFunctionDefinition {
  generatorId: string           // Unique identifier
  generatorVersion: number      // For staleness tracking
  inputTypes: string[]          // Data types this handles ("*" for all)
  dependsOn: string[]           // Other generators this depends on
  generate(input, context): Promise<GeneratingFunctionOutput>
}
```

### Built-in generators

| Generator | ID | Input types | Output |
|-----------|------|-------------|--------|
| Image dimensions | `image-dimensions` | JPEG, PNG, WebP, GIF | `{ width, height, format }` |
| File properties | `file-properties` | All (`*`) | `{ extension, mimeType, sizeBytes }` |
| Text preview | `text-preview` | Plain text, Markdown, JSON | `{ preview, totalLines, characterCount }` |

### Generation flow

1. Register generators in a `GeneratorRegistry`
2. Build a `DependencyGraph` to determine execution order
3. The `MetadataEngine` generates metadata on demand or via queue
4. Input hashing (`computeInputHash`) detects stale metadata
5. Cached results are returned when inputs haven't changed

### Dependency graph

Generators can depend on other generators. The dependency graph:
- Ensures correct execution order (topological sort)
- Detects circular dependencies
- Cascades regeneration when upstream metadata changes

### Migrations

When a generator's output schema changes:

```typescript
const migration: MetadataMigration = {
  generatorId: "image-dimensions",
  fromVersion: 1,
  toVersion: 2,
  migrate(existingValue) {
    return { ...existingValue, orientation: "landscape" }
  },
}
```

## 7. Index and Aggregations

### Unified index

The `UnifiedIndex` joins data records with their metadata for combined queries:

```typescript
interface IndexQuery {
  types?: string[]                    // Filter by data type
  dateRange?: { start, end }          // Filter by creation date
  metadataFilters?: MetadataFilter[]  // Filter by metadata fields
  syncBoundary?: SyncBoundaryFilter   // Filter by sync eligibility
  limit?: number
  cursor?: string
}
```

Results include both the data record and all associated metadata:

```typescript
interface IndexItem {
  dataRecord: DataRecord
  metadata: Record<string, MetadataRecord>  // keyed by generatorId
}
```

### Sync boundary

The sync boundary tracks which records are eligible for synchronization:

```typescript
interface SyncBoundary {
  markSyncEligible(recordId): Promise<void>
  markLocalOnly(recordId): Promise<void>
  isSyncEligible(recordId): Promise<boolean>
  getSyncEligibleIds(since?): Promise<StarkeepId[]>
}
```

### Aggregations

Aggregations compute summaries over record sets:

```typescript
interface AggregationResult {
  totalCount: number
  totalSizeBytes: number
  countsByType: Record<string, number>
  countsByMimeType: Record<string, number>
  dateHistogram: DateHistogramBucket[]
}
```

Aggregations support incremental updates — when records change, only the affected counts are recomputed.

## 8. Sync Protocol

### Change log

Every mutation is recorded in an append-only change log:

```typescript
interface ChangeLogEntry {
  changeId: StarkeepId
  recordId: StarkeepId
  operation: "create" | "update" | "delete"
  timestamp: HLCTimestamp
  recordSnapshot: AnyRecord
}
```

### Sync operations

| Operation | Description |
|-----------|-------------|
| `pull()` | Fetch remote changes since last sync point |
| `push()` | Send local changes to remote |
| `fullSync()` | Pull then push |

### Conflict resolution

When the same record is modified locally and remotely:

1. Both changes are compared by HLC timestamp
2. **Last-writer-wins**: the change with the later HLC timestamp is kept
3. The losing change is recorded as a `ConflictResolution`
4. A `conflict-detected` event is emitted

### File sync

Files sync by content hash:
1. Compare local and remote file manifests
2. Transfer only files whose hash doesn't exist at the destination
3. Content-addressable storage prevents redundant transfers

### Change notifications

Applications subscribe to sync events:

```typescript
const unsubscribe = syncEngine.changeNotifier.subscribe((event) => {
  // event.eventType: "remote-update-available" | "local-data-synced" | "conflict-detected"
  // event.recordIds: affected records
  // event.timestamp: when it happened
})
```

## 9. Access Control

### Policy model

Policies define who can do what:

```typescript
interface AccessPolicy {
  policyId: StarkeepId
  subjectType: "user" | "app" | "api" | "token"
  subjectId: string
  resourceType: "item" | "type" | "collection" | "wildcard"
  resourceId: string
  permissions: ("read" | "write" | "delete" | "admin")[]
  grantedAt: HLCTimestamp
  expiresAt: HLCTimestamp | null
}
```

### Enforcement

The `EnforcedDatabaseAdapter` wraps any `DatabaseAdapter` and checks permissions on every operation. This ensures access control applies uniformly regardless of which code path accesses data.

### Sharing tokens

For external sharing:
1. Create a policy granting specific permissions
2. Generate a cryptographic token tied to that policy
3. Share the token externally
4. Token validation returns the associated policy
5. Tokens support expiration and usage limits

## 10. Shared Space APIs

### API framework

The Shared Space API provides versioned, namespaced HTTP endpoints:

```typescript
const endpoint: ApiEndpointDefinition = {
  namespace: "photos",
  version: "v1",
  path: "/albums/:id",
  method: "GET",
  handler: async (request, context) => {
    // request.subject: authenticated caller
    // context.databaseAdapter: database access
    return { status: 200, body: album }
  },
}
```

Endpoints are registered in an `ApiRouter` and dispatched by the `SharedSpaceApi`.

### Request model

```typescript
interface ApiRequest {
  path: string
  method: string
  body?: unknown
  query?: Record<string, string>
  headers?: Record<string, string>
  subject: { subjectType: string; subjectId: string }
}
```

## 11. Error Hierarchy

```
StarkeepError (base)
  ├── ValidationError
  ├── NotFoundError
  ├── ConflictError
  ├── StorageError
  │     ├── ConnectionError
  │     ├── TransactionError
  │     ├── MigrationError
  │     └── ObjectNotFoundError
  ├── MetadataEngineError
  │     ├── GenerationError
  │     ├── CyclicDependencyError
  │     └── GeneratorNotFoundError
  ├── SyncError
  │     └── SyncConflictError
  ├── AccessDeniedError
  ├── PolicyNotFoundError
  └── ApiError
        ├── RouteNotFoundError
        └── MethodNotAllowedError
```
