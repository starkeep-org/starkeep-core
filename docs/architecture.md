# Architecture

## Layers

Starkeep is organized into four layers, each building on the one below it.

```
+-----------------------------------------------------------+
|                       App Layer                           |
|  Your application — uses the SDK directly                 |
+-----------------------------------------------------------+
|                      SDK Facade                           |
|  createStarkeepSdk() — single entry point                 |
+------------+-------------------+----------+---------------+
|   Index    |  Metadata Engine  |  Aggreg. |  Shared Space |
|  (search)  |  (generators)     |  (stats) |    API        |
+------------+-------------------+----------+---------------+
|  Sync Engine           |  Access Control                  |
+------------------------+----------------------------------+
|                Protocol Core                              |
|  Identifiers · Records · HLC · Type Registry             |
+-----------------------------------------------------------+
|              Storage Abstraction Layer                    |
|  SQLite    Aurora DSQL    S3    Local Filesystem          |
+-----------------------------------------------------------+
```

**App layer** — your code. Apps call `createStarkeepSdk()` and use the returned object.
No app code should import from individual protocol packages directly; the SDK exposes
everything needed.

**SDK facade** (`@starkeep/sdk`) — wires all subsystems together with a single call. Accepts
local and optional remote adapters; exposes `data`, `metadata`, `index`, `aggregations`,
`sync`, `accessControl`, and `api` namespaces.

**Services layer** — independent, composable subsystems. Each can be used directly if you
need lower-level control, but most apps don't need to.

**Protocol core** (`@starkeep/core`) — the shared foundation: identifiers, record types,
HLC clocks, the type registry, and validation schemas. Every other package depends on this.

**Storage abstraction** — two interfaces (`DatabaseAdapter`, `ObjectStorageAdapter`) with
multiple implementations. Swapping implementations changes the storage backend without
changing any application code.

## Package dependency graph

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
@starkeep/sdk  (depends on all of the above)

@starkeep/aws-provider  (independent — infrastructure only)
```

## Local vs. cloud

The same application code runs in two configurations, distinguished only by which adapters
are passed to the SDK:

**Local only** — SQLite + local filesystem. No network required. Data stays on the device.

```
App ──> SDK ──> SQLite (database)
             └─> Local FS (files)
```

**With sync** — local adapters plus remote adapters. Pull-then-push sync keeps both sides
in agreement.

```
App ──> SDK ──> SQLite   <──sync──> Aurora DSQL
             └─> Local FS <──sync──> S3
```

The Tasks desktop app uses the local configuration by default and syncs when cloud
credentials are provided. The Tasks web app uses the cloud configuration directly.

## Design principles

**Database-agnostic.** All data access goes through the `DatabaseAdapter` and
`ObjectStorageAdapter` interfaces. Storage backends can be swapped or mocked without
changing application logic.

**Data is independent of metadata.** Data records stand alone in the unified `records`
table. Metadata is stored in separate per-type tables (e.g. `metadata_todo_task`) with
typed columns for each generator's output. Data records have no knowledge of their
metadata; adding or removing generators has no effect on stored data.

**Access control at the storage layer.** The `EnforcedDatabaseAdapter` wrapper checks
every operation against access policies before forwarding it. Access control is uniform
regardless of which code path triggered the operation.

**Causal ordering without coordination.** Hybrid Logical Clocks timestamp every mutation.
Because HLC timestamps incorporate a node identifier, two events on different devices can
always be put in a deterministic total order — no coordination or consensus required.

**Functional factory pattern.** Subsystems are created with `createXyz()` functions rather
than classes. This makes dependencies explicit and simplifies testing.

## Data model

### Records

Every piece of data in Starkeep is a **record**. There are two kinds:

**Data records** represent user content — photos, documents, conversations, messages. They have:
- A globally unique ULID identifier
- HLC timestamps for creation and last update
- An owner, sync status, and version number
- Optional file backing (content hash, object storage key, MIME type, size)
- A freeform `payload` object for structured data

**Metadata records** are associated with a data record and produced by generators whose
inputs may include the data record, user-supplied parameters, or both. A generator is
marked `syncable: true` when its output is non-deterministic or involves user input —
meaning two devices may independently produce different values and conflict resolution is
required. Non-syncable generators produce the same output for the same input on any device
and do not participate in sync.

All metadata records have:
- A `targetId` pointing to the data record they describe
- Generator identification (ID + version) for staleness tracking
- An `inputHash` for cache validation
- A `value` object containing the generated metadata

Syncable metadata records additionally have:
- An `updatedAt` HLC timestamp (stored in the `metadata_sync` table) for conflict resolution
- A JSON snapshot in the `metadata_sync` table used by the sync engine for pull/push

### Identifiers

All records use **ULIDs** (Universally Unique Lexicographically Sortable Identifiers). ULIDs encode a millisecond timestamp in their first 48 bits, making them naturally sortable by creation time while remaining globally unique.

### Timestamps

Starkeep uses **Hybrid Logical Clocks** for all timestamps. An HLC timestamp has three components:

| Component | Purpose |
|-----------|---------|
| `wallTime` | Physical clock time (milliseconds) |
| `counter` | Logical counter for events at the same wall time |
| `nodeId` | Node identifier for total ordering across nodes |

HLCs provide causal ordering without coordination, monotonic progression, and total ordering for deterministic conflict resolution.

## Sync architecture

```
Local Device                        Cloud (per-user)
+------------------+               +------------------+
| SQLite           |  <-- sync --> | Aurora DSQL      |
| Local FS         |  <-- sync --> | S3               |
| Change Log       |               | Change Log       |
+------------------+               +------------------+
```

Sync follows a pull-then-push model:

1. **Pull** — fetch remote changes since last sync point
2. **Merge** — apply HLC ordering to resolve conflicts across data records and syncable metadata records (last-writer-wins per field); non-syncable metadata is excluded
3. **Push** — send local changes to remote
4. **File sync** — transfer files by content hash to avoid redundant transfers
5. **Notify** — emit change events for UI updates

## Access control model

Access control is enforced at the storage layer via the `EnforcedDatabaseAdapter` wrapper. This means access checks apply uniformly regardless of which component accesses data.

Policies specify:
- **Subject** — who (user, app, API, token)
- **Resource** — what (specific item, type, collection, or wildcard)
- **Permissions** — which operations (read, write, delete, admin)
- **Expiration** — optional time-limited access

External sharing uses cryptographically secure tokens tied to policies.

## Per-user infrastructure model

Each user gets an isolated AWS stack provisioned by `@starkeep/aws-provider`:

```
Per-user stack
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

Provisioning and deprovisioning are orchestrated through the Pulumi Automation API.
No shared database, no shared bucket — every user's data is physically separate.
