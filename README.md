# Starkeep Data Protocol

A user-owned data platform where app users control their own cloud instance and app developers build on a shared, governed data layer. The data protocol defines how data and metadata are stored, indexed, synced, and accessed — both locally and in the cloud.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      App Layer                          │
│  (photo management, AI assistant, admin panel)          │
├─────────────────────────────────────────────────────────┤
│                     SDK Facade                          │
├──────────────┬──────────────────────────┬───────────────┤
│   Index      │   Metadata Engine        │  Aggregations │
│   (search &  │   (generating functions, │  (counts,     │
│    sync      │    dependency tracking,  │   sizes,      │
│    boundary) │    migrations)           │   histograms) │
├──────────────┴──────────────────────────┴───────────────┤
│  Sync Engine  │  Access Control  │  Shared Space APIs   │
├──────────────────────────────────────────────────────────┤
│                  Data Protocol Core                      │
│  (identifiers, records, schemas, HLC)                   │
├──────────────────────────────────────────────────────────┤
│               Storage Abstraction Layer                  │
│  ┌──────────┐  ┌───────────┐  ┌──────┐  ┌───────────┐  │
│  │  SQLite   │  │ Aurora    │  │  S3  │  │ Local FS  │  │
│  │  (local)  │  │ DSQL     │  │      │  │           │  │
│  └──────────┘  └───────────┘  └──────┘  └───────────┘  │
└──────────────────────────────────────────────────────────┘
```

### Key design decisions

- **Database-agnostic storage** via abstract adapter interfaces
- **Hybrid Logical Clocks (HLC)** for conflict resolution in bidirectional sync
- **Data independence from metadata** — data items stand alone, metadata references data
- **Functional style** — factory functions (`createXyz()`) over classes
- **Valibot** for schema validation

## Packages

| Package | Description |
|---------|-------------|
| `@starkeep/core` | Identifiers (ULID), HLC, records, schema validation, type registry |
| `@starkeep/storage-adapter` | Abstract `DatabaseAdapter` and `ObjectStorageAdapter` interfaces + mocks |
| `@starkeep/storage-sqlite` | SQLite adapter using `node:sqlite` (Node.js 22+) |
| `@starkeep/storage-aurora-dsql` | Aurora DSQL adapter for AWS cloud deployments |
| `@starkeep/storage-s3` | S3 object storage adapter |
| `@starkeep/storage-fs` | Local filesystem object storage adapter |
| `@starkeep/metadata-engine` | Generator registry, dependency graph, input hashing, generation queue |
| `@starkeep/metadata-core` | Built-in generators: image dimensions, file properties, text preview |
| `@starkeep/index` | Unified query orchestrator over data + metadata |
| `@starkeep/aggregations` | Counts, sizes, date histograms |
| `@starkeep/sync-engine` | Change log, conflict resolution, file sync, change notifications |
| `@starkeep/access-control` | Policy model, enforced adapter wrapper, sharing tokens |
| `@starkeep/shared-space-api` | Versioned API router and middleware |
| `@starkeep/aws-provider` | Pulumi-based per-user AWS provisioning |
| `@starkeep/sdk` | High-level facade over all packages |

## Example apps

| App | Description |
|-----|-------------|
| `examples/photo-app` | Google Photos-like app (React + Vite) |
| `examples/ai-assistant` | Conversation-based AI UI (React + Vite) |
| `examples/admin-panel` | Deployment, permissions, and data dashboard (React + Vite) |

## Getting started

### Prerequisites

- Node.js >= 22
- pnpm 10.20.0+

### Setup

```bash
pnpm install
pnpm build
pnpm test
```

### Running an example

```bash
pnpm --filter @starkeep/example-photo-app dev
pnpm --filter @starkeep/example-ai-assistant dev
pnpm --filter @starkeep/example-admin-panel dev
```

### Available scripts

```bash
pnpm build          # Build all packages
pnpm test           # Run all tests
pnpm typecheck      # Type-check all packages
pnpm lint           # Lint all packages
pnpm format         # Format with Prettier
pnpm format:check   # Check formatting
pnpm --filter @starkeep/admin-core build  # Rebuild the bootstrap CloudFormation template
```

## Tooling

- **pnpm workspaces** + **Turborepo** for monorepo management
- **tsup** (esbuild) for building ESM + CJS + declaration files
- **vitest** for testing
- **TypeScript** 5.x in strict mode
- **SST v4** + **Pulumi Automation API** for deployment (platform layer + per-user provisioning)

## License

Private
