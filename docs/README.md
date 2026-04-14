# Starkeep Documentation

Starkeep is a protocol for building apps where each user controls their own data. Users get
isolated cloud infrastructure (database, file storage, API) that belongs to them — not to the
app developer. Developers build on a shared, governed data layer that handles storage, search,
metadata generation, sync, and access control.

## What you can build

- **Offline-first apps** that work locally on any device and sync to the cloud on demand
- **Multi-device apps** where changes made on one device appear on others without manual
  conflict resolution
- **Data-portable apps** where users own and can export everything they create
- **Collaborative apps** where users share subsets of their data with others via policies
  and revocable tokens

## How it works

Every app user gets their own cloud stack — an Aurora DSQL database, an S3 bucket, and an
API Gateway — provisioned automatically. App code stores data through abstract adapters,
so the same code runs against local SQLite in development and Aurora DSQL in production.
The SDK wires everything together: data operations, metadata generation, search, aggregations,
sync, and access control through a single entry point.

On the local machine, the **data-server** is the hub for all local apps. Rather than each
app embedding the SDK with its own private database, local apps are thin HTTP clients that
route all reads and writes through the data-server. This gives every local app a consistent,
shared view of the data without coordination. See [Architecture](architecture.md) for the
full local multi-app deployment model.

Reference apps include the [Tasks app](tasks-app.md) (web + Tauri desktop), the
[data-server](../apps/data-server/) (the local data hub — embeds the SDK and exposes it
over a REST API at `127.0.0.1:9820`), the [Photos app](../apps/photos-desktop/) (a Tauri
desktop app and reference implementation of the thin-client pattern), and the
[File Provider](../apps/file-provider/) (a macOS File Provider and Finder Sync extension
that surfaces Starkeep data as a native filesystem location).

## Documentation

| | |
|--|--|
| [Core Concepts](concepts.md) | Data records, metadata, sync, access control, identifiers |
| [Architecture](architecture.md) | Layer diagram, package graph, design principles |
| [Getting Started](getting-started.md) | Install, initialize the SDK, store and query data |
| [Building an App](building-an-app.md) | SDK-embedded pattern (Tasks app) and thin-client pattern (Photos app) |
| [Infrastructure](infrastructure.md) | Per-user AWS provisioning with Pulumi |
| [Reference](reference.md) | Record fields, error types, type naming conventions |

### Package docs

| Package | What it does |
|---------|-------------|
| [@starkeep/core](packages/core.md) | Identifiers, HLC timestamps, record types, type registry, validation |
| [@starkeep/storage-adapter](packages/storage-adapter.md) | Storage interfaces and mock implementations |
| [@starkeep/storage-sqlite](packages/storage-sqlite.md) | Local SQLite database adapter |
| [@starkeep/storage-fs](packages/storage-fs.md) | Local filesystem object storage adapter |
| [@starkeep/storage-aurora-dsql](packages/storage-aurora-dsql.md) | Cloud Aurora DSQL database adapter |
| [@starkeep/storage-s3](packages/storage-s3.md) | Cloud S3 object storage adapter |
| [@starkeep/metadata-engine](packages/metadata-engine.md) | Metadata generation orchestration |
| [@starkeep/metadata-core](packages/metadata-core.md) | Built-in metadata generators |
| [@starkeep/index](packages/index.md) | Unified search across data and metadata |
| [@starkeep/aggregations](packages/aggregations.md) | Counts, sizes, and histograms |
| [@starkeep/sync-engine](packages/sync-engine.md) | Bidirectional local-cloud sync |
| [@starkeep/access-control](packages/access-control.md) | Policies, permissions, sharing tokens |
| [@starkeep/shared-space-api](packages/shared-space-api.md) | Versioned HTTP API framework |
| [@starkeep/sdk](packages/sdk.md) | Unified facade — start here |
| [@starkeep/aws-provider](packages/aws-provider.md) | Per-user AWS infrastructure provisioning |

### Apps

| | |
|--|--|
| [Tasks App](tasks-app.md) | Task management — web and desktop; reference for the SDK-embedded pattern |
| [Data Server](../apps/data-server/) | Local data hub — embeds the SDK, owns the type registry, serves all local apps over HTTP |
| [Photos App](../apps/photos-desktop/) | Desktop photo library — reference for the thin-client (data-server) pattern |
| [File Provider](../apps/file-provider/) | macOS File Provider + Finder Sync extension — thin client that exposes Starkeep data in Finder |

### Analysis

| | |
|--|--|
| [Authentication](auth-analysis.md) | Auth options for owner access, sharing, app-to-API, and sync |
