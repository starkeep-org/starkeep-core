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

The data-server is the single point of truth locally. Multiple apps share it. Data created by one app is immediately visible to another — local access control is advisory, not enforced at the IAM layer.

## Cloud Topology

In the cloud, each installed app's requests are routed through the protocol-core Lambda (the cloud equivalent of the local data-server). The Lambda has no direct data-plane access — it assumes a per-app IAM role for every request:

```
App request (JWT authed)
  → API Gateway
    → protocol-core Lambda
      → STS: assume ${stackPrefix}-app-${appId}-role  (cached ~14 min)
        → DSQL as ${stackPrefix}_app_${appId} PG role
        → S3 under apps/${appId}/ prefix
```

Data sync between local and cloud:

```
data-server ──▶ SQLite (local writes)
              └▶ Aurora DSQL (cloud sync via Lambda API, per-app credentials)
              └▶ S3 (file sync, scoped to app prefix)
```

## IAM Role Hierarchy

Every identity that accesses cloud data flows through a fixed role chain. See [Role Taxonomy](role-taxonomy.md) for full details.

```
Cognito identity (human operator)
  └──▶ admin-app role          (Cognito federation)
         └──▶ Manager role     (sts:AssumeRole — install/uninstall only)
               └──▶ per-app role  (sts:AssumeRole — data access)
```

The per-app role is bounded by the app permissions boundary. Its inline policies are generated from the app manifest — only the types the app declares get S3 and DSQL grants. IAM is the enforcement layer, not application code.

## App Lifecycle

Apps are installed and uninstalled through the admin-web UI, which calls the `admin-installer` package. Installation is a 11-step idempotent state machine:

1. Create IAM role (Manager credentials)
2. Attach temp-install policy to the role
3. Assume app role
4. Run DSQL DDL (create PG role, app schema, shared grants, access_grants rows)
5. Put S3 sentinel file
6. Upload app bundle (dist.zip)
7. Install compute stack via Pulumi (Lambda + API Gateway routes, if enabled)
8. Detach temp-install policy
9. Create access policies in admin DB
10. Register app in admin DB

Each step is recorded in `app_install_steps`. Failed installs can be retried — completed steps are skipped.

## Multi-App Access to Shared Data

Apps that need to read each other's data do so via the `shared.*` PG schema. The `shared.access_grants` table declares what each app is allowed to read or write. The protocol-core Lambda enforces this at the application layer (sync filters) while DSQL PG role grants enforce it at the DB layer.

The two enforcement layers are consistent: install DDL writes rows to `shared.access_grants` that mirror the IAM policy grants derived from the manifest. Neither layer alone is the sole enforcement point.

## Packages

The SDK is assembled from composable packages. Each package has a focused responsibility:

| Package | Responsibility |
|---|---|
| `@starkeep/core` | Identifiers (ULID), HLC timestamps, schema validation |
| `@starkeep/storage-adapter` | Abstract database and object storage interfaces |
| `@starkeep/storage-sqlite` | SQLite database adapter (local) |
| `@starkeep/storage-aurora-dsql` | Aurora DSQL adapter (cloud) |
| `@starkeep/storage-fs` | Filesystem object storage adapter (local) |
| `@starkeep/storage-s3` | S3 object storage adapter (cloud) |
| `@starkeep/index` | Unified query interface |
| `@starkeep/aggregations` | Counts, storage totals, date histograms |
| `@starkeep/sync-engine` | Bidirectional sync, change log, conflict resolution |
| `@starkeep/shared-space-api` | Versioned HTTP API routing framework |
| `@starkeep/sdk` | High-level facade wiring all packages together |
| `@starkeep/admin-manifest` | App manifest schema + validation |
| `@starkeep/admin-core` | Bootstrap CloudFormation template generation |
| `@starkeep/admin-installer` | Per-app install/uninstall orchestration |

## Design Principles

**Per-app IAM isolation** — Each installed app has its own IAM role, bounded by a permissions boundary. The role's grants are derived mechanically from the manifest. There is no trust that app code will self-limit its access.

**Manifest-driven provisioning** — An app declares what it needs in `manifest.json`. The installer reads the manifest and provisions exactly that — no more, no less. Apps cannot request capabilities outside the manifest schema.

**Database-agnostic** — All storage access goes through adapter interfaces. Local and cloud use different implementations of the same interface, so application code is identical in both environments.

**Data independent of metadata** — Records are complete without their metadata. Metadata references records; records never reference metadata. See [Data vs. Metadata App Architecture](data-vs-metadata-app-architecture.md).

**Causal ordering without coordination** — HLC timestamps let any device resolve conflicts deterministically without talking to a central server.
