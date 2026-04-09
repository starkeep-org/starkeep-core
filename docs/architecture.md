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

**Data is independent of metadata.** Data records stand alone. Metadata records reference
data, but data records have no knowledge of their metadata. Adding or removing generators
has no effect on stored data.

**Access control at the storage layer.** The `EnforcedDatabaseAdapter` wrapper checks
every operation against access policies before forwarding it. Access control is uniform
regardless of which code path triggered the operation.

**Causal ordering without coordination.** Hybrid Logical Clocks timestamp every mutation.
Because HLC timestamps incorporate a node identifier, two events on different devices can
always be put in a deterministic total order — no coordination or consensus required.

**Functional factory pattern.** Subsystems are created with `createXyz()` functions rather
than classes. This makes dependencies explicit and simplifies testing.

## Per-user infrastructure model

Each user gets an isolated AWS stack provisioned by `@starkeep/aws-provider`:

```
Per-user stack
+--------------------------------------------------+
|  API Gateway  -->  handlers                      |
|                                                  |
|  Aurora DSQL  <->  data + metadata records       |
|  S3 Bucket    <->  files (photos, documents)     |
|                                                  |
|  IAM roles + security groups                     |
+--------------------------------------------------+
```

Provisioning and deprovisioning are orchestrated through the Pulumi Automation API.
No shared database, no shared bucket — every user's data is physically separate.
