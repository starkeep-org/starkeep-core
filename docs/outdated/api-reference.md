# API Reference

## @starkeep/core

Protocol fundamentals: identifiers, HLC timestamps, records, type registry, and schema validation.

### Identifiers

```typescript
import {
  generateId,
  generateIdAt,
  createStarkeepId,
  isStarkeepId,
  type StarkeepId,
} from "@starkeep/core"
```

| Function | Signature | Description |
|----------|-----------|-------------|
| `generateId` | `() => StarkeepId` | Generate a new monotonic ULID |
| `generateIdAt` | `(timestamp: number) => StarkeepId` | Generate a ULID at a specific timestamp |
| `createStarkeepId` | `(value: string) => StarkeepId` | Brand an existing string |
| `isStarkeepId` | `(value: unknown) => value is StarkeepId` | Type guard |

### HLC

```typescript
import {
  createHLCClock,
  compareHLC,
  maxHLC,
  serializeHLC,
  deserializeHLC,
  type HLCTimestamp,
  type HLCClock,
} from "@starkeep/core"
```

**`createHLCClock(options)`**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `options.nodeId` | `string` | Yes | Node identifier for tie-breaking |
| `options.wallClockFunction` | `() => number` | No | Physical clock source (defaults to `Date.now`) |

Returns `HLCClock` with methods:

| Method | Signature | Description |
|--------|-----------|-------------|
| `now` | `() => HLCTimestamp` | Current timestamp |
| `send` | `() => HLCTimestamp` | Timestamp for outgoing messages |
| `receive` | `(remote: HLCTimestamp) => HLCTimestamp` | Merge remote timestamp |

**Utilities**

| Function | Signature | Description |
|----------|-----------|-------------|
| `compareHLC` | `(a, b) => -1 \| 0 \| 1` | Compare two timestamps |
| `maxHLC` | `(a, b) => HLCTimestamp` | Return the greater timestamp |
| `serializeHLC` | `(timestamp) => string` | Serialize to `"wallTime:counter:nodeId"` |
| `deserializeHLC` | `(serialized) => HLCTimestamp` | Parse serialized string |

### Records

```typescript
import {
  createDataRecord,
  createMetadataRecord,
  type DataRecord,
  type MetadataRecord,
  type AnyRecord,
  type SyncStatus,
  type CreateDataRecordInput,
  type CreateMetadataRecordInput,
} from "@starkeep/core"
```

**`createDataRecord(input, clock)`**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `input.type` | `string` | Yes | Data type |
| `input.ownerId` | `string` | Yes | Owner identifier |
| `input.payload` | `Record<string, unknown>` | No | Structured data |
| `input.contentHash` | `string \| null` | No | SHA-256 of file content |
| `input.objectStorageKey` | `string \| null` | No | Object storage key |
| `input.mimeType` | `string \| null` | No | MIME type |
| `input.sizeBytes` | `number \| null` | No | File size in bytes |
| `clock` | `HLCClock` | Yes | Clock for timestamps |

**`createMetadataRecord(input, clock)`**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `input.type` | `string` | Yes | Metadata type |
| `input.ownerId` | `string` | Yes | Owner identifier |
| `input.targetId` | `StarkeepId` | Yes | Data record this describes |
| `input.generatorId` | `string` | Yes | Generator identifier |
| `input.generatorVersion` | `number` | Yes | Generator version |
| `input.inputHash` | `string` | Yes | Hash of generator inputs |
| `input.value` | `Record<string, unknown>` | Yes | Generated metadata |
| `clock` | `HLCClock` | Yes | Clock for timestamps |

### Schema Validation

```typescript
import {
  validateDataRecord,
  validateMetadataRecord,
  validateAnyRecord,
  dataRecordSchema,
  metadataRecordSchema,
  anyRecordSchema,
} from "@starkeep/core"
```

### Type Registry

```typescript
import {
  createTypeRegistry,
  type TypeRegistry,
  type TypeDefinition,
} from "@starkeep/core"
```

**`createTypeRegistry()`** — Returns a `TypeRegistry` with methods:

| Method | Signature | Description |
|--------|-----------|-------------|
| `register` | `(definition: TypeDefinition) => void` | Register a type |
| `get` | `(namespace, name) => TypeDefinition \| undefined` | Retrieve by namespace + name |
| `getByKey` | `(key: string) => TypeDefinition \| undefined` | Retrieve by `"namespace:name"` |
| `has` | `(namespace, name) => boolean` | Check existence |
| `list` | `() => TypeDefinition[]` | List all registered types |

### Errors and Utilities

```typescript
import {
  StarkeepError,
  ValidationError,
  NotFoundError,
  ConflictError,
  ok,
  err,
  type Result,
  type PaginationOptions,
  type PaginatedResult,
} from "@starkeep/core"
```

---

## @starkeep/storage-adapter

Abstract interfaces for database and object storage, plus mock implementations for testing.

### DatabaseAdapter

```typescript
import {
  type DatabaseAdapter,
  type Query,
  type QueryResult,
  type Filter,
  type SortField,
  type BatchOperation,
  type Transaction,
  type Migration,
  MockDatabaseAdapter,
} from "@starkeep/storage-adapter"
```

See [protocol.md — Storage Abstraction](protocol.md#5-storage-abstraction) for the full interface definition.

**Filter operators**: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in`, `like`

**Sort directions**: `"asc"`, `"desc"`

### ObjectStorageAdapter

```typescript
import {
  type ObjectStorageAdapter,
  type PutOptions,
  type GetResult,
  type ListOptions,
  type ListResult,
  type SignedUrlOptions,
  MockObjectStorageAdapter,
} from "@starkeep/storage-adapter"
```

### Errors

```typescript
import {
  StorageError,
  ConnectionError,
  TransactionError,
  MigrationError,
  ObjectNotFoundError,
} from "@starkeep/storage-adapter"
```

---

## @starkeep/storage-sqlite

SQLite implementation of `DatabaseAdapter` using Node.js 22+ built-in `node:sqlite`.

```typescript
import { SqliteDatabaseAdapter } from "@starkeep/storage-sqlite"

const adapter = new SqliteDatabaseAdapter({ path: "./data.db" })
// or in-memory:
const adapter = new SqliteDatabaseAdapter({ path: ":memory:" })

await adapter.init()
```

Features: WAL mode, foreign keys, indexed columns (type, sync_status, target_id, updated_at, kind), SAVEPOINT-based transactions.

---

## @starkeep/storage-fs

Filesystem implementation of `ObjectStorageAdapter`.

```typescript
import { FsObjectStorageAdapter } from "@starkeep/storage-fs"

const adapter = new FsObjectStorageAdapter({ basePath: "./storage" })
await adapter.init()
```

Features: sharded directory layout (first 2 chars of key), `.meta.json` sidecar files for metadata.

---

## @starkeep/storage-s3

AWS S3 implementation of `ObjectStorageAdapter`.

```typescript
import { S3ObjectStorageAdapter } from "@starkeep/storage-s3"

const adapter = new S3ObjectStorageAdapter({
  bucketName: "my-bucket",
  region: "us-east-1",
  keyPrefix: "user-data/",        // optional
  credentials: {                   // optional, defaults to env/IAM
    accessKeyId: "...",
    secretAccessKey: "...",
  },
})
await adapter.init()
```

Features: multipart upload for files > 5MB, signed URL generation, lazy client initialization.

---

## @starkeep/storage-aurora-dsql

Aurora DSQL implementation of `DatabaseAdapter`.

```typescript
import {
  AuroraDsqlDatabaseAdapter,
  type DatabaseClientFactory,
} from "@starkeep/storage-aurora-dsql"

const adapter = new AuroraDsqlDatabaseAdapter(
  { hostname: "cluster.xxx.us-east-1.dsql.amazonaws.com", region: "us-east-1" },
  myClientFactory,  // you provide a DatabaseClientFactory implementation
)
await adapter.init()
```

The `DatabaseClientFactory` interface must be implemented with a PostgreSQL client (e.g., `pg`, `@aws-sdk/client-dsql`):

```typescript
interface DatabaseClientFactory {
  createClient(options: AuroraDsqlDatabaseAdapterOptions): Promise<DatabaseClient>
}

interface DatabaseClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>
  end(): Promise<void>
}
```

---

## @starkeep/metadata-engine

Metadata generation orchestration.

```typescript
import {
  createGeneratorRegistry,
  createDependencyGraph,
  createMetadataEngine,
  createGenerationQueue,
  createMigrationRunner,
  computeInputHash,
  type GeneratorRegistry,
  type DependencyGraph,
  type MetadataEngine,
  type GenerationQueue,
  type GeneratingFunctionDefinition,
  type GenerationRequest,
  type GenerationResult,
  type MetadataMigration,
} from "@starkeep/metadata-engine"
```

### createMetadataEngine(options)

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `options.databaseAdapter` | `DatabaseAdapter` | Yes | Database access |
| `options.objectStorageAdapter` | `ObjectStorageAdapter` | Yes | File access |
| `options.clock` | `HLCClock` | Yes | Timestamp source |
| `options.ownerId` | `string` | Yes | Owner identifier |
| `options.generatorRegistry` | `GeneratorRegistry` | Yes | Registered generators |
| `options.dependencyGraph` | `DependencyGraph` | Yes | Generator dependencies |

Returns `MetadataEngine` with methods:

| Method | Signature | Description |
|--------|-----------|-------------|
| `generate` | `(request: GenerationRequest) => Promise<GenerationResult>` | Generate single metadata |
| `generateAll` | `(targetId, dataType) => Promise<GenerationResult[]>` | Generate all applicable metadata |
| `checkStaleness` | `(metadataRecordId) => Promise<boolean>` | Check if metadata is outdated |

### GeneratingFunctionDefinition

```typescript
interface GeneratingFunctionDefinition {
  generatorId: string
  generatorVersion: number
  inputTypes: string[]          // data types to handle, or ["*"] for all
  dependsOn: string[]           // generator IDs this depends on
  generate(
    input: GeneratingFunctionInput,
    context: GenerationContext,
  ): Promise<GeneratingFunctionOutput>
}
```

---

## @starkeep/metadata-core

Built-in metadata generators.

```typescript
import {
  IMAGE_DIMENSIONS_GENERATOR,
  FILE_PROPERTIES_GENERATOR,
  TEXT_PREVIEW_GENERATOR,
  registerCoreMetadataGenerators,
} from "@starkeep/metadata-core"
```

| Generator | ID | Handles | Output |
|-----------|----|---------|--------|
| `IMAGE_DIMENSIONS_GENERATOR` | `image-dimensions` | JPEG, PNG, WebP, GIF | `{ width, height, format }` |
| `FILE_PROPERTIES_GENERATOR` | `file-properties` | All types | `{ extension, mimeType, sizeBytes }` |
| `TEXT_PREVIEW_GENERATOR` | `text-preview` | Text, Markdown, JSON | `{ preview, totalLines, characterCount }` |

**`registerCoreMetadataGenerators(registry)`** — Registers all three generators at once.

---

## @starkeep/index

Unified query interface combining data records and metadata.

```typescript
import {
  createUnifiedIndex,
  createSyncBoundary,
  type UnifiedIndex,
  type SyncBoundary,
  type IndexQuery,
  type IndexItem,
  type IndexResult,
  type MetadataFilter,
} from "@starkeep/index"
```

### createUnifiedIndex(options)

| Parameter | Type | Required |
|-----------|------|----------|
| `options.databaseAdapter` | `DatabaseAdapter` | Yes |

Returns `UnifiedIndex`:

| Method | Signature | Description |
|--------|-----------|-------------|
| `search` | `(query: IndexQuery) => Promise<IndexResult>` | Combined data + metadata search |
| `getWithMetadata` | `(recordId) => Promise<IndexItem \| null>` | Single record with all metadata |
| `syncBoundary` | `SyncBoundary` | Sync eligibility management |

### IndexQuery

```typescript
interface IndexQuery {
  types?: string[]                           // filter by data type
  dateRange?: { start, end: HLCTimestamp }   // filter by creation date
  metadataFilters?: MetadataFilter[]         // filter by metadata fields
  syncBoundary?: "sync-eligible" | "local-only" | "all"
  limit?: number
  cursor?: string
}
```

---

## @starkeep/aggregations

Analytical aggregations with caching.

```typescript
import {
  createAggregationEngine,
  computeDateBucket,
  buildDateHistogram,
  type AggregationEngine,
  type AggregationResult,
  type AggregationOptions,
  type DateGranularity,
} from "@starkeep/aggregations"
```

### createAggregationEngine(options)

| Parameter | Type | Required |
|-----------|------|----------|
| `options.databaseAdapter` | `DatabaseAdapter` | Yes |

Returns `AggregationEngine`:

| Method | Signature | Description |
|--------|-----------|-------------|
| `compute` | `(options?) => Promise<AggregationResult>` | Full aggregation |
| `incrementalUpdate` | `(changedRecordIds) => Promise<AggregationResult>` | Incremental recompute |
| `getCached` | `() => AggregationResult \| null` | Get cached result |
| `invalidate` | `() => void` | Clear cache |

**`AggregationOptions`**: `{ types?: string[], dateGranularity?: "day" | "week" | "month" | "year" }`

---

## @starkeep/sync-engine

Bidirectional sync with conflict resolution.

```typescript
import {
  createSyncEngine,
  createChangeLog,
  createChangeNotifier,
  createFileSyncEngine,
  resolveConflict,
  type SyncEngine,
  type ChangeLog,
  type ChangeNotifier,
  type ChangeLogEntry,
  type SyncPullResponse,
  type SyncPushResponse,
  type ConflictResolution,
  type ChangeEvent,
  type ChangeListener,
} from "@starkeep/sync-engine"
```

### createSyncEngine(options)

| Parameter | Type | Required |
|-----------|------|----------|
| `options.localDatabaseAdapter` | `DatabaseAdapter` | Yes |
| `options.remoteDatabaseAdapter` | `DatabaseAdapter` | Yes |
| `options.localObjectStorage` | `ObjectStorageAdapter` | Yes |
| `options.remoteObjectStorage` | `ObjectStorageAdapter` | Yes |
| `options.clock` | `HLCClock` | Yes |

Returns `SyncEngine`:

| Method / Property | Signature | Description |
|-------------------|-----------|-------------|
| `recordChange` | `(operation, record) => Promise<void>` | Record a local mutation |
| `pull` | `() => Promise<SyncPullResponse>` | Pull remote changes |
| `push` | `() => Promise<SyncPushResponse>` | Push local changes |
| `fullSync` | `() => Promise<{ pulled, pushed, conflicts }>` | Bidirectional sync |
| `changeLog` | `ChangeLog` | Access to change log |
| `changeNotifier` | `ChangeNotifier` | Access to event emitter |

---

## @starkeep/access-control

Fine-grained access control.

```typescript
import {
  createAccessControlEngine,
  createEnforcedDatabaseAdapter,
  generateToken,
  hashToken,
  resolvePolicy,
  AccessDeniedError,
  PolicyNotFoundError,
  type AccessControlEngine,
  type AccessPolicy,
  type CreatePolicyInput,
  type AccessCheckRequest,
  type AccessCheckResult,
  type Permission,
  type SubjectType,
  type ResourceType,
} from "@starkeep/access-control"
```

### createAccessControlEngine(options)

| Parameter | Type | Required |
|-----------|------|----------|
| `options.databaseAdapter` | `DatabaseAdapter` | Yes |
| `options.clock` | `HLCClock` | Yes |
| `options.ownerId` | `string` | Yes |

Returns `AccessControlEngine`:

| Method | Signature | Description |
|--------|-----------|-------------|
| `createPolicy` | `(input) => Promise<AccessPolicy>` | Create access policy |
| `revokePolicy` | `(policyId) => Promise<void>` | Revoke policy |
| `listPolicies` | `(options?) => Promise<AccessPolicy[]>` | List policies |
| `checkAccess` | `(request) => Promise<AccessCheckResult>` | Check permission |
| `createSharingToken` | `(policyId, options?) => Promise<{ token, tokenId }>` | Create share link |
| `validateSharingToken` | `(token) => Promise<AccessPolicy \| null>` | Validate token |

### createEnforcedDatabaseAdapter(adapter, engine, subject)

Wraps a `DatabaseAdapter` to enforce access checks on every operation.

---

## @starkeep/shared-space-api

Versioned HTTP API router.

```typescript
import {
  createSharedSpaceApi,
  createApiRouter,
  parseQueryParams,
  formatPaginatedResponse,
  ApiError,
  RouteNotFoundError,
  MethodNotAllowedError,
  type SharedSpaceApi,
  type ApiRouter,
  type ApiEndpointDefinition,
  type ApiRequest,
  type ApiResponse,
  type ApiHandler,
  type ApiContext,
  type ApiSubject,
} from "@starkeep/shared-space-api"
```

### createSharedSpaceApi(options)

| Parameter | Type | Required |
|-----------|------|----------|
| `options.databaseAdapter` | `DatabaseAdapter` | Yes |
| `options.objectStorageAdapter` | `ObjectStorageAdapter` | Yes |
| `options.clock` | `HLCClock` | Yes |
| `options.ownerId` | `string` | Yes |

Returns `SharedSpaceApi`:

| Method / Property | Signature | Description |
|-------------------|-----------|-------------|
| `router` | `ApiRouter` | Endpoint registration |
| `handleRequest` | `(request) => Promise<ApiResponse>` | Dispatch request |

---

## @starkeep/aws-provider

Per-user AWS infrastructure provisioning via Pulumi.

```typescript
import {
  createAwsProvider,
  createMockStackProgram,
  buildStackName,
  parseStackName,
  buildBucketName,
  buildClusterIdentifier,
  type AwsProvider,
  type AwsProviderOptions,
  type StackProgram,
  type UserProvisioningOptions,
  type ProvisionedResources,
  type DeprovisionResult,
} from "@starkeep/aws-provider"
```

### createAwsProvider(options, stackProgram)

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `options.projectName` | `string` | Yes | Pulumi project name |
| `options.region` | `string` | Yes | Default AWS region |
| `options.stateBackend` | `"local" \| "s3"` | No | State storage backend |
| `stackProgram` | `StackProgram` | Yes | Pulumi automation interface |

Returns `AwsProvider`:

| Method | Signature | Description |
|--------|-----------|-------------|
| `provisionUser` | `(options) => Promise<ProvisionedResources>` | Create user infrastructure |
| `deprovisionUser` | `(userId) => Promise<DeprovisionResult>` | Destroy user infrastructure |
| `getResources` | `(userId) => Promise<ProvisionedResources \| null>` | Get current resources |
| `listUsers` | `() => Promise<string[]>` | List provisioned users |

### Naming utilities

| Function | Signature | Example output |
|----------|-----------|----------------|
| `buildStackName` | `(projectName, userId) => string` | `"starkeep-user-alice"` |
| `buildBucketName` | `(projectName, userId) => string` | `"starkeep-alice-data"` |
| `buildClusterIdentifier` | `(projectName, userId) => string` | `"starkeep-alice-cluster"` |

---

## @starkeep/sdk

High-level facade over all packages.

```typescript
import {
  createStarkeepSdk,
  type StarkeepSdk,
  type StarkeepSdkOptions,
  type DataOperations,
  type MetadataOperations,
  type IndexOperations,
  type AggregationOperations,
  type SyncOperations,
  type AccessControlOperations,
  type ApiOperations,
} from "@starkeep/sdk"
```

### createStarkeepSdk(options)

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `options.databaseAdapter` | `DatabaseAdapter` | Yes | Local database |
| `options.objectStorageAdapter` | `ObjectStorageAdapter` | Yes | Local file storage |
| `options.ownerId` | `string` | Yes | User identifier |
| `options.nodeId` | `string` | Yes | HLC node identifier |
| `options.clock` | `HLCClock` | No | Custom clock (auto-created if omitted) |
| `options.remoteDatabaseAdapter` | `DatabaseAdapter` | No | Remote database for sync |
| `options.remoteObjectStorageAdapter` | `ObjectStorageAdapter` | No | Remote file storage for sync |
| `options.generators` | `GeneratingFunctionDefinition[]` | No | Custom metadata generators |

Returns `Promise<StarkeepSdk>`:

| Property | Type | Description |
|----------|------|-------------|
| `data` | `DataOperations` | Create, read, delete data records |
| `metadata` | `MetadataOperations` | Generate and query metadata |
| `index` | `IndexOperations` | Search across data + metadata |
| `aggregations` | `AggregationOperations` | Compute summaries |
| `sync` | `SyncOperations \| null` | Sync operations (null if no remote adapters) |
| `accessControl` | `AccessControlOperations` | Policies and permissions |
| `api` | `ApiOperations` | HTTP-like API dispatch |
| `close` | `() => Promise<void>` | Cleanup all resources |

### DataOperations

| Method | Signature | Description |
|--------|-----------|-------------|
| `put` | `(input) => Promise<DataRecord>` | Create or update a data record |
| `putWithFile` | `(input, file, contentType?) => Promise<DataRecord>` | Create record with file |
| `get` | `(recordId) => Promise<DataRecord \| null>` | Fetch by ID |
| `delete` | `(recordId) => Promise<void>` | Delete record |

### SyncOperations

Available only when remote adapters are provided.

| Method | Signature | Description |
|--------|-----------|-------------|
| `push` | `() => Promise<{ pushed, conflicts }>` | Push local changes |
| `pull` | `() => Promise<{ pulled }>` | Pull remote changes |
| `fullSync` | `() => Promise<{ pulled, pushed, conflicts }>` | Bidirectional sync |
| `onUpdate` | `(listener) => () => void` | Subscribe to sync events (returns unsubscribe) |
