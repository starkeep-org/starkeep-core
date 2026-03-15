# Architecture

## Overview

Starkeep is a user-owned data platform where each app user controls their own cloud infrastructure. App developers build on a shared, governed data layer called the **data protocol**, which defines how data and metadata are stored, indexed, synced, and accessed — both locally and in the cloud.

## Design Principles

- **User-owned infrastructure.** Each user gets their own isolated AWS resources (Aurora DSQL, S3, API Gateway). No shared multi-tenant database.
- **Database-agnostic storage.** All data access goes through abstract adapter interfaces. Swap SQLite for Aurora DSQL (or any future adapter) without changing application code.
- **Data independence from metadata.** Data records stand alone. Metadata references data, but data never depends on metadata. This allows metadata generators to evolve independently.
- **Hybrid Logical Clocks (HLC).** Conflict resolution uses HLCs — they combine physical timestamps with logical counters and node IDs, providing causal ordering without coordination.
- **Functional style.** Factory functions (`createXyz()`) over classes throughout the codebase.

## Layer Diagram

```
+-----------------------------------------------------------+
|                       App Layer                           |
|  (photo-app, ai-assistant, admin-panel)                   |
+-----------------------------------------------------------+
|                      SDK Facade                           |
|  createStarkeepSdk() -> unified API                       |
+------------+-------------------+----------+---------------+
|   Index    |  Metadata Engine  |  Aggreg. |  Shared Space |
|  (search & |  (generators,     |  (counts,|    APIs       |
|   sync     |   dependencies,   |   sizes, |  (versioned   |
|   boundary)|   migrations)     |   histo.)|   router)     |
+------------+-------------------+----------+---------------+
|  Sync Engine           |  Access Control                  |
|  (HLC conflict res.,   |  (policies, enforced adapter,    |
|   file sync, notifs)   |   sharing tokens)                |
+------------------------+----------------------------------+
|                Data Protocol Core                         |
|  (identifiers, records, HLC, type registry, validation)   |
+-----------------------------------------------------------+
|              Storage Abstraction Layer                     |
|  +----------+  +-----------+  +------+  +-------------+  |
|  |  SQLite   |  | Aurora    |  |  S3  |  |  Local FS   |  |
|  |  (local)  |  | DSQL      |  |      |  |             |  |
|  +----------+  +-----------+  +------+  +-------------+  |
+-----------------------------------------------------------+
```

## Package Dependency Graph

```
@starkeep/core
    |
    v
@starkeep/storage-adapter
    |
    +---> @starkeep/storage-sqlite
    +---> @starkeep/storage-aurora-dsql
    +---> @starkeep/storage-s3
    +---> @starkeep/storage-fs
    |
    +---> @starkeep/metadata-engine ---> @starkeep/metadata-core
    +---> @starkeep/index
    +---> @starkeep/aggregations
    +---> @starkeep/sync-engine
    +---> @starkeep/access-control
    +---> @starkeep/shared-space-api
    |
    v
@starkeep/sdk  (depends on all above)

@starkeep/aws-provider  (independent — infrastructure orchestration)
```

## Data Model

### Records

Every piece of data in Starkeep is a **record**. There are two kinds:

**Data records** represent user content — photos, documents, conversations, messages. They have:
- A globally unique ULID identifier
- HLC timestamps for creation and last update
- An owner, sync status, and version number
- Optional file backing (content hash, object storage key, MIME type, size)
- A freeform `payload` object for structured data

**Metadata records** are derived from data records by generators. They have:
- The same base fields as data records
- A `targetId` pointing to the data record they describe
- Generator identification (ID + version) for staleness tracking
- An `inputHash` for cache validation
- A `value` object containing the generated metadata

### Identifiers

All records use **ULIDs** (Universally Unique Lexicographically Sortable Identifiers). ULIDs encode a millisecond timestamp in their first 48 bits, making them naturally sortable by creation time while remaining globally unique.

### Timestamps

Starkeep uses **Hybrid Logical Clocks** for all timestamps. An HLC timestamp has three components:

| Component | Purpose |
|-----------|---------|
| `wallTime` | Physical clock time (milliseconds) |
| `counter` | Logical counter for events at the same wall time |
| `nodeId` | Node identifier for total ordering across nodes |

HLCs provide:
- Causal ordering without coordination
- Monotonic progression (never goes backward)
- Total ordering for deterministic conflict resolution

## Sync Architecture

```
Local Device                        Cloud (per-user)
+------------------+               +------------------+
| SQLite           |  <-- sync --> | Aurora DSQL      |
| Local FS         |  <-- sync --> | S3               |
| Change Log       |               | Change Log       |
+------------------+               +------------------+
```

Sync follows a pull-then-push model:

1. **Pull**: Fetch remote changes since last sync point
2. **Merge**: Apply HLC ordering to resolve conflicts (last-writer-wins per field)
3. **Push**: Send local changes to remote
4. **File sync**: Transfer files by content hash to avoid redundant transfers
5. **Notify**: Emit change events for UI updates

## Access Control Model

Access control is enforced at the storage abstraction layer via an **enforced adapter wrapper**. This means access checks apply uniformly regardless of which component accesses data.

Policies specify:
- **Subject**: who (user, app, API, token)
- **Resource**: what (specific item, type, collection, or wildcard)
- **Permissions**: which operations (read, write, delete, admin)
- **Expiration**: optional time-limited access

External sharing uses cryptographically secure tokens tied to policies.

## AWS Deployment Model

Each user gets isolated infrastructure provisioned via the Pulumi Automation API:

```
Per-user stack:
+--------------------------------------------------+
|  API Gateway  -->  Lambda Functions               |
|                    (sync, metadata, API handlers) |
|                                                   |
|  Aurora DSQL  <->  Data + Metadata Records        |
|  S3 Bucket    <->  Files (photos, documents)      |
|                                                   |
|  IAM Roles + Security Groups                      |
+--------------------------------------------------+
```

The `@starkeep/aws-provider` package orchestrates provisioning and deprovisioning through a `StackProgram` interface that abstracts Pulumi operations.
