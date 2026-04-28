# Architecture

## System Overview

Starkeep is organized in layers. From top to bottom:

```
┌─────────────────────────────────────────────────┐
│                    Apps                         │
│   admin-web  │  photos-web  │  file-browser     │
└──────────────┬──────────────────────────────────┘
               │ HTTP
┌──────────────▼──────────────────────────────────┐
│               data-server                       │
│   Local HTTP hub exposing the SDK over REST     │
└──────────────┬──────────────────────────────────┘
               │ adapter interfaces
┌──────────────▼──────────────────────────────────┐
│                    SDK                          │
│  Records · Metadata · Search · Sync · Access    │
└──────────┬──────────────────────┬───────────────┘
           │                      │
┌──────────▼──────┐    ┌──────────▼──────────────┐
│  Database       │    │  Object Storage          │
│  SQLite (local) │    │  Filesystem (local)      │
│  Aurora DSQL    │    │  S3 (cloud)              │
│  (cloud)        │    │                          │
└─────────────────┘    └──────────────────────────┘
```

The SDK is the core of the system. It defines all data operations and enforces the rules (access control, schema validation, conflict resolution). Apps never touch storage directly — they always go through the SDK, either by embedding it or by calling the data-server's HTTP API.

## Local Topology

In local development, a single data-server instance runs on the machine and serves all apps:

```
admin-web (port 3000) ──┐
                         ├──▶ data-server (port 9820) ──▶ SQLite + filesystem
photos-web (port 3000) ──┘
file-browser (port 5173) ─────────────────────────────▶ data-server (port 9820)
```

The data-server is the single point of truth locally. It owns the type registry and storage, and multiple apps share it. This means data created by one app is immediately visible to another.

## Cloud Topology

When cloud infrastructure is provisioned, the data-server gains remote adapters and syncs with the user's cloud stack:

```
data-server ──▶ SQLite (local writes)
              └▶ Aurora DSQL (cloud sync via Lambda API)
              └▶ S3 (file sync)
```

The data-server pulls remote changes on a configurable interval and pushes local changes when they occur. All sync goes through the user's own AWS resources — the data never passes through a shared multi-tenant backend.

## Multi-App Deployment

The data-server pattern enables multiple apps to share a single SDK instance on one machine. Apps that implement the thin-client pattern (photos-web, file-browser) make HTTP requests to the data-server rather than each embedding their own SDK and SQLite database. This avoids conflicts between multiple processes writing to the same database file and ensures all apps see a consistent view of the data.

Apps that need standalone operation (e.g., a task manager that works without other apps running) can embed the SDK directly with their own adapters.

## Packages

The SDK is assembled from composable packages. Each package has a focused responsibility:

| Package | Responsibility |
|---|---|
| `@starkeep/core` | Identifiers (ULID), HLC timestamps, type registry, schema validation |
| `@starkeep/storage-adapter` | Abstract database and object storage interfaces |
| `@starkeep/storage-sqlite` | SQLite database adapter (local) |
| `@starkeep/storage-aurora-dsql` | Aurora DSQL adapter (cloud) |
| `@starkeep/storage-fs` | Filesystem object storage adapter (local) |
| `@starkeep/storage-s3` | S3 object storage adapter (cloud) |
| `@starkeep/metadata-engine` | Generator registry, dependency graph, generation queue |
| `@starkeep/metadata-core` | Built-in generators (image dimensions, file properties, text preview) |
| `@starkeep/index` | Unified query interface joining data and metadata |
| `@starkeep/aggregations` | Counts, storage totals, date histograms |
| `@starkeep/sync-engine` | Bidirectional sync, change log, conflict resolution |
| `@starkeep/access-control` | Policy-based access control enforced at the storage layer |
| `@starkeep/shared-space-api` | Versioned HTTP API routing framework |
| `@starkeep/sdk` | High-level facade wiring all packages together |
| `@starkeep/aws-provider` | Per-user AWS provisioning via Pulumi Automation API |

## Design Principles

**Database-agnostic** — All storage access goes through adapter interfaces. Local and cloud use different implementations of the same interface, so application code is identical in both environments.

**Data independent of metadata** — Records are complete without their metadata. Metadata references records; records never reference metadata. See [Data vs. Metadata App Architecture](data-vs-metadata-app-architecture.md).

**Access control at the storage layer** — Policies are enforced by a wrapping adapter that intercepts every read and write. There is no application-level bypass.

**Causal ordering without coordination** — HLC timestamps let any device resolve conflicts deterministically without talking to a central server.

**Factory functions over classes** — All subsystems are created with `createXyz()` functions that take explicit dependencies. This makes the dependency graph visible and testable.
