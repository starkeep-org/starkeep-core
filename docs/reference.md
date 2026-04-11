# Reference

## Data record fields

Every data record has these fields:

| Field | Type | Description |
|-------|------|-------------|
| `id` | `StarkeepId` | Unique ULID identifier |
| `kind` | `"data"` | Discriminator |
| `type` | `string` | Namespaced type key (`namespace:name`) |
| `createdAt` | `HLCTimestamp` | Creation timestamp |
| `updatedAt` | `HLCTimestamp` | Last modification timestamp |
| `ownerId` | `string` | Owner identifier |
| `syncStatus` | `SyncStatus` | Sync state (see below) |
| `deletedAt` | `HLCTimestamp \| null` | Soft-delete timestamp; `null` if not deleted |
| `version` | `number` | Monotonic version counter; increments on each update |
| `payload` | `Record<string, unknown>` | Application-defined structured data |
| `contentHash` | `string \| null` | SHA-256 of file content; `null` for record-only data |
| `objectStorageKey` | `string \| null` | Key in object storage; `null` for record-only data |
| `mimeType` | `string \| null` | MIME type of the file; `null` for record-only data |
| `sizeBytes` | `number \| null` | File size in bytes; `null` for record-only data |

Records where `contentHash` is non-null are **file-backed**. Records where it is null
contain only structured payload data.

## Metadata record fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | `StarkeepId` | Unique identifier |
| `kind` | `"metadata"` | Discriminator |
| `type` | `string` | Namespaced metadata type key |
| `createdAt` | `HLCTimestamp` | Creation timestamp |
| `updatedAt` | `HLCTimestamp` | Last update timestamp |
| `ownerId` | `string` | Owner identifier |
| `syncStatus` | `SyncStatus` | Sync state |
| `deletedAt` | `HLCTimestamp \| null` | Soft-delete timestamp |
| `version` | `number` | Version counter |
| `targetId` | `StarkeepId` | ID of the data record this describes |
| `generatorId` | `string` | Generator that produced this record |
| `generatorVersion` | `number` | Version of the generator at time of generation |
| `inputHash` | `string` | Hash of the inputs used; used for staleness detection |
| `value` | `Record<string, unknown>` | The generated metadata content |

## Sync status lifecycle

```
"local" ──> "pending_push" ──> "synced"
                                  │
                              "pending_pull"
                                  │
                              "conflict"
```

| Status | Meaning |
|--------|---------|
| `local` | Exists only locally; never synced |
| `pending_push` | Has local changes not yet pushed to the cloud |
| `synced` | In sync with the cloud |
| `pending_pull` | Remote changes exist that haven't been applied locally |
| `conflict` | Both local and remote have changes that conflict |

## HLC timestamp fields

| Field | Type | Description |
|-------|------|-------------|
| `wallTime` | `number` | Physical clock time in milliseconds since epoch |
| `counter` | `number` | Logical counter; increments for events at the same `wallTime` |
| `nodeId` | `string` | Node identifier; used for total ordering across devices |

Serialized format: `"wallTime:counter:nodeId"` (e.g., `"1735689600000:0:laptop-abc"`).

## Type naming conventions

All types follow the pattern `namespace:name`:

- Namespaces are lowercase with hyphens; prefer short, distinctive names
- Built-in generators use `@starkeep/metadata-core` as their namespace
- Application types should use the app name or organization as the namespace
- Avoid generic namespaces like `app` or `default` that may collide

Examples:

| Key | What it names |
|-----|--------------|
| `tasks:task` | A task in the Tasks app |
| `tasks:group` | A task group |
| `photos:photo` | A photo |
| `@starkeep/metadata-core:image-dimensions` | Built-in image dimensions metadata |
| `@starkeep/metadata-core:file-properties` | Built-in file properties metadata |
| `@starkeep/metadata-core:text-preview` | Built-in text preview metadata |

## Error hierarchy

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

All errors extend `StarkeepError`, so you can catch the base class to handle any protocol
error, or catch specific subclasses for targeted handling.

## Package index

| Package | Import |
|---------|--------|
| Core | `@starkeep/core` |
| Storage interfaces | `@starkeep/storage-adapter` |
| SQLite adapter | `@starkeep/storage-sqlite` |
| Filesystem adapter | `@starkeep/storage-fs` |
| Aurora DSQL adapter | `@starkeep/storage-aurora-dsql` |
| S3 adapter | `@starkeep/storage-s3` |
| Metadata engine | `@starkeep/metadata-engine` |
| Built-in generators | `@starkeep/metadata-core` |
| Unified index | `@starkeep/index` |
| Aggregations | `@starkeep/aggregations` |
| Sync engine | `@starkeep/sync-engine` |
| Access control | `@starkeep/access-control` |
| HTTP API framework | `@starkeep/shared-space-api` |
| SDK | `@starkeep/sdk` |
| AWS provisioning | `@starkeep/aws-provider` |
