# Starkeep Data Protocol — Plan

## Overview

Starkeep is a user-owned data platform where app users control their own cloud instance, and app developers build on a shared, governed data layer. The **data protocol** defines how data and metadata are stored, indexed, synced, and accessed — both locally and in the cloud.

This repository is a **TypeScript monorepo** containing the protocol specification, core libraries, storage adapters, sync engine, and Shared Space APIs.

---

## Architecture

### High-Level Components

```
┌─────────────────────────────────────────────────────────┐
│                      App Layer                          │
│  (e.g. photo management app, AI assistant app)          │
├─────────────────────────────────────────────────────────┤
│                  Shared Space APIs                      │
│  (versioned endpoints, registered per library)          │
├──────────────┬──────────────────────────┬───────────────┤
│   Index      │   Metadata Engine        │  Aggregations │
│   (search    │   (generating functions, │  (counts,     │
│    & sync    │    dependency tracking,  │   sizes, etc) │
│    boundary) │    migrations)           │               │
├──────────────┴──────────────────────────┴───────────────┤
│                  Data Protocol Core                     │
│  (identifiers, records, schemas, HLC, access control)   │
├──────────────────────────────────────────────────────────┤
│               Storage Abstraction Layer                  │
│  ┌──────────┐  ┌───────────┐  ┌─────────────────────┐  │
│  │  SQLite   │  │ Aurora    │  │  Future adapters    │  │
│  │  (local)  │  │ DSQL     │  │  (DynamoDB, etc)    │  │
│  └──────────┘  └───────────┘  └─────────────────────┘  │
├──────────────────────────────────────────────────────────┤
│               Object Storage Abstraction                 │
│  ┌──────────┐  ┌───────────┐  ┌─────────────────────┐  │
│  │  Local FS │  │  S3       │  │  Future adapters    │  │
│  └──────────┘  └───────────┘  └─────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

### Key Design Decisions

- **Database-agnostic storage** via an abstract adapter interface. Default implementations: SQLite (local), Aurora DSQL (cloud/AWS).
- **Provider-agnostic cloud layer** with AWS as the first implementation. The abstraction allows future support for other providers.
- **Hybrid Logical Clocks (HLC)** for conflict resolution in bidirectional sync. HLCs combine physical timestamps with logical counters, providing causal ordering without coordination — well-suited for a system where local and cloud edits happen independently.
- **Data independence from metadata.** Data items stand alone. Metadata references data but data never depends on metadata.
- **SQLite as default local database**, with the storage abstraction allowing other implementations (IndexedDB, LevelDB, etc.) for different runtime environments.

---

## Monorepo Structure

```
packages/
  core/                  # Protocol core: identifiers, schemas, HLC, types
  storage-adapter/       # Abstract storage interfaces (database + object storage)
  storage-sqlite/        # SQLite adapter (local)
  storage-aurora-dsql/   # Aurora DSQL adapter (cloud)
  storage-s3/            # S3 object storage adapter
  storage-fs/            # Local filesystem object storage adapter
  metadata-engine/       # Metadata generation, dependency tracking, migrations
  metadata-core/         # Core metadata library (common extractors: dimensions, etc.)
  index/                 # Index management, search, sync boundary
  aggregations/          # Analytical aggregations (counts, sizes, etc.)
  sync-engine/           # Bidirectional local <-> cloud sync with HLC
  access-control/        # Access control policies and enforcement
  shared-space-api/      # Shared Space API framework (versioned, registered endpoints)
  aws-provider/          # AWS-specific orchestration (Lambda, S3, Aurora DSQL)
```

---

## Phases

### Phase 1 — Protocol Core & Storage Foundation

Define the fundamental building blocks: how data and metadata are identified, structured, and persisted.

#### 1.1 Protocol Core (`packages/core`)

- **Identifier system.** Define a globally unique identifier scheme for all data and metadata items. Must be sortable and compatible with HLC timestamps.
  - *Example: a photo app assigns each uploaded photo a unique ID; an AI assistant assigns each conversation and message a unique ID.*
- **Base record schema.** Define the database record structure that every data and metadata item must have — ID, type, timestamps (HLC), ownership, and sync status.
- **HLC implementation.** Implement Hybrid Logical Clocks: clock initialization, timestamp generation, merging/comparison, and serialization.
- **Type system.** Define the type registry for data and metadata kinds. Each type is globally namespaced to the library that defines it.
  - *Example: `@starkeep/metadata-core:image-dimensions` for image width/height metadata.*
- **Schema validation.** Lightweight validation for record schemas, extensible by metadata libraries.

#### 1.2 Storage Abstraction (`packages/storage-adapter`)

- **Database adapter interface.** Abstract interface for CRUD operations on records, queries, transactions, and migrations.
  - Operations: `put`, `get`, `delete`, `query` (with filtering/sorting/pagination), `batch`, `transaction`.
  - Must support both data records and metadata records uniformly.
- **Object storage adapter interface.** Abstract interface for file storage: `put`, `get`, `delete`, `list`, `getSignedUrl`.
  - Separates file blobs from their database records.
- **Adapter lifecycle.** Initialization, schema migration hooks, and health checks.

#### 1.3 SQLite Adapter (`packages/storage-sqlite`)

- Implement the database adapter interface using SQLite (via `better-sqlite3`).
- Schema creation and migration support.
- Full query support with filtering, sorting, and pagination.
- Transaction support.
- *This is the default local adapter. Example: a photo app stores its index of all photos locally in SQLite; an AI assistant stores conversation history locally.*

#### 1.4 Local Object Storage (`packages/storage-fs`)

- Implement the object storage adapter interface using the local filesystem.
- Content-addressable storage layout (by hash or ID).
- *Example: photo files stored on disk, referenced by their data record in SQLite.*

### Phase 2 — Data & Metadata Layer

Build the systems that manage data items and metadata generation.

#### 2.1 Data Layer (within `packages/core` or dedicated package)

- **Data record management.** CRUD for data items, enforcing the rule that every data item has a database record with a unique identifier.
- **File-backed vs record-only data.** Support data items that are files (photos, documents) and data items that are pure records (a conversation message, a preference).
- **Data integrity.** Content hashing for file-backed data to detect corruption and support deduplication.

#### 2.2 Metadata Engine (`packages/metadata-engine`)

- **Generating function registry.** A system for registering metadata generating functions, namespaced by library.
  - Each function declares its inputs (data items, other metadata items, parameters, user input).
  - *Example: an image-dimensions function takes an image data item and outputs width/height metadata.*
- **Input tracking and hashing.** Each metadata record stores references to its generating inputs and a hash of those inputs. This enables:
  - Staleness detection (re-run if inputs changed).
  - Cache validity (skip generation if inputs unchanged).
- **On-demand and queued generation.** Support both synchronous generation (on-demand) and asynchronous generation (queued for later).
  - *Example: thumbnail generation for a photo could be queued; an AI assistant might generate conversation summaries on demand.*
- **Dependency graph.** Track dependencies between metadata items so that changes cascade correctly.

#### 2.3 Core Metadata Library (`packages/metadata-core`)

- Implement common metadata extractors as the first metadata library:
  - Image dimensions (width, height)
  - Image thumbnails (multiple sizes)
  - File size, MIME type, content hash
  - Text extraction / preview
- Serve as the reference implementation for how metadata libraries are structured.

#### 2.4 Metadata Migrations

- **Migration framework.** When a metadata library introduces a breaking change, it must include a migration.
  - Migrations are checked into the library and run as part of the upgrade process.
  - Migrations can transform existing metadata records to the new schema.
- **Version tracking.** Each metadata record tracks which version of the generating function produced it.

### Phase 3 — Index & Aggregations

Build the query and analytics layer that makes data and metadata discoverable.

#### 3.1 Index (`packages/index`)

- **Unified index.** An index over all data and metadata in the Shared Space, optimized for search and retrieval.
  - Supports filtering by type, date range, tags, and arbitrary metadata fields.
  - *Example: "find all photos taken in 2024 with width > 1920" or "find all AI conversations mentioning 'project alpha'."*
- **Sync boundary management.** The index maintains which items are authorized to sync between local and cloud.
  - Items in the Local Shared Space are marked as sync-eligible.
  - Items in local private space are excluded from sync.
- **Index synchronization.** The index itself syncs between local and cloud, so queries work consistently regardless of where they run.

#### 3.2 Aggregations (`packages/aggregations`)

- **Common aggregations.** Counts, total sizes, breakdowns by type, date histograms.
  - *Example: "12,847 photos, 48.2 GB total" in a photo app dashboard; "342 conversations this month" in an AI assistant.*
- **Incremental updates.** Aggregations update incrementally as data changes, rather than recomputing from scratch.
- **Local and cloud availability.** Aggregations are computed locally and synced, providing instant UI responsiveness.

### Phase 4 — Sync Engine

Build the bidirectional sync mechanism between local and cloud.

#### 4.1 HLC-Based Sync Protocol (`packages/sync-engine`)

- **Change tracking.** Every mutation (create, update, delete) is tagged with an HLC timestamp. Changes are tracked in a local change log.
- **Sync protocol.** Define the wire protocol for exchanging changes between local and cloud:
  - Pull: fetch remote changes since last sync point.
  - Push: send local changes since last sync point.
  - Merge: apply HLC ordering to resolve conflicts.
- **Conflict resolution strategy.** HLC provides a total ordering of events. For Phase 4, use **last-writer-wins per field** based on HLC timestamps. This is simple, deterministic, and sufficient for most cases.
  - *Example: if a user renames a photo album locally while the cloud has a different rename, the one with the later HLC timestamp wins.*
- **Sync boundary enforcement.** Only items marked as sync-eligible in the index are included in sync operations.
- **File sync.** Coordinate database record sync with object storage file sync. Files are synced by content hash to avoid redundant transfers.

#### 4.2 Change Notifications

- **Local notification system.** Apps can subscribe to notifications when:
  - Cloud Shared Space data is updated (new data available to pull).
  - Local Shared Space data is updated via sync (data changed after pull).
  - *Example: a photo app refreshes its gallery when new photos arrive from the cloud; an AI assistant shows a badge when a conversation was updated on another device.*

### Phase 5 — Access Control

Define and enforce who can access what.

#### 5.1 Access Control (`packages/access-control`)

- **Policy model.** App users define access control policies on data and metadata items. Policies specify which users, apps, and APIs can read/write specific items.
  - Granularity: per-item, per-type, per-collection, or wildcard.
  - *Example: a user shares a photo album with specific external users (read-only); an AI assistant's conversation history is private by default.*
- **Enforcement layer.** Access control is enforced at the storage abstraction layer, so it applies uniformly regardless of which app or API is accessing the data.
- **External sharing.** Support sharing data with external users (non-Starkeep users) via controlled access tokens or links.

### Phase 6 — Shared Space APIs

Build the API framework that apps use to interact with the Shared Space.

#### 6.1 API Framework (`packages/shared-space-api`)

- **Versioned API endpoints.** Each API is versioned and registered with a unique namespace at the library level.
  - *Example: `@starkeep/api-photos:v1/albums/list`, `@starkeep/api-assistant:v1/conversations/search`.*
- **Common retrieval patterns.** Standardized query, pagination, filtering, and sorting across all APIs.
- **Unified local/cloud interface.** The same API works whether the data is local or in the cloud. The API layer routes to the appropriate storage based on availability and sync status.
- **API registration system.** APIs are registered globally so the system knows which endpoints exist and which libraries provide them.

#### 6.2 API Libraries

- Provide tooling for app developers to define and publish Shared Space APIs as open-source libraries.
- Each API library is a dependency of any app that uses it, ensuring type safety and version compatibility.

### Phase 7 — AWS Provider

Implement the cloud layer on AWS.

#### 7.1 AWS Cloud Adapter (`packages/storage-aurora-dsql`, `packages/storage-s3`)

- **Aurora DSQL adapter.** Implement the database adapter interface using Aurora DSQL (PostgreSQL-compatible).
- **S3 adapter.** Implement the object storage adapter interface using S3.
- **Connection management.** Handle connection pooling, authentication, and error handling for serverless environments.

#### 7.2 AWS Orchestration (`packages/aws-provider`)

- **Lambda-based compute.** Package metadata generation, sync operations, and API endpoints as Lambda functions.
- **Infrastructure as code.** Provide deployment templates (CDK or similar) for provisioning a user's Starkeep cloud instance on AWS.
  - Aurora DSQL cluster, S3 buckets, Lambda functions, API Gateway.
- **Per-user isolation.** Each app user owns their own AWS infrastructure. The provider package handles provisioning and teardown.
- **Event-driven metadata generation.** Use S3 event notifications or similar to trigger queued metadata generation when new data arrives.

### Phase 8 — Developer Tooling & Registry

Make it easy for app developers to build on Starkeep.

#### 8.1 Metadata Library Tooling

- **Library scaffold CLI.** Generate a new metadata library with the correct structure, namespace registration, and migration boilerplate.
- **Testing utilities.** Helpers for testing metadata generating functions in isolation.

#### 8.2 Global Registry

- **Namespace registry.** A registry (could be a simple package registry or dedicated service) for metadata libraries and API endpoints.
- **Validation.** Ensure namespaces are unique and libraries meet community standards before registration.

#### 8.3 Developer SDK

- **High-level SDK.** A convenience layer over the raw packages that provides a simple interface for common app developer tasks:
  - Store and retrieve data.
  - Generate and query metadata.
  - Subscribe to changes.
  - Call Shared Space APIs.
  - *Example: `starkeep.data.put(photo)`, `starkeep.metadata.generate('image-dimensions', photo)`, `starkeep.sync.pull()`.*

---

## Cross-Cutting Concerns

### Testing Strategy

- Unit tests for each package in isolation.
- Integration tests using SQLite + local filesystem (fast, no cloud dependencies).
- End-to-end tests against AWS (Aurora DSQL + S3) in a test environment.
- Sync tests simulating multiple clients with concurrent mutations.

### Error Handling

- All adapter interfaces define explicit error types.
- Sync errors are recoverable — failed syncs can be retried without data loss.
- Metadata generation failures are tracked and retriable.

### Observability

- Structured logging across all packages.
- Sync operation metrics (items synced, conflicts resolved, latency).
- Metadata generation metrics (queue depth, generation time, failure rate).

### Documentation

- Each package includes API documentation.
- Protocol specification as a standalone document.
- App developer guide with end-to-end examples.
