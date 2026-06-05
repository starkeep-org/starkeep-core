# Starkeep Data Protocol — Instructions

## Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| Node.js | >= 22 | Runtime (uses built-in `node:sqlite`) |
| pnpm | 10.20.0+ | Package manager |
| Rust + Cargo | Latest stable | Required for Tauri desktop builds |
| AWS CLI v2 | Latest | AWS credential management |
| Pulumi CLI | >= 3.x | Infrastructure provisioning (for AWS deployment) |

### Install Rust (for Tauri)

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

### Install Pulumi

```bash
curl -fsSL https://get.pulumi.com | sh
```

---

## Local Development

### 1. Install dependencies and build

```bash
pnpm install
pnpm build
```

### 2. Run tests

```bash
pnpm test
```

### 3. Run an example app (browser)

```bash
pnpm --filter @starkeep/example-photo-app dev
pnpm --filter @starkeep/example-ai-assistant dev
pnpm --filter @starkeep/example-admin-panel dev
```

### 4. Run the admin panel as a Tauri desktop app

```bash
pnpm --filter @starkeep/example-admin-panel tauri:dev
```

For a production build:

```bash
pnpm --filter @starkeep/example-admin-panel tauri:build
```

The output binary will be in `examples/admin-panel/src-tauri/target/release/bundle/`.

> All example apps use mock adapters locally — no AWS account needed for development.

---

## AWS Deployment

Starkeep deploys into a single customer-owned AWS account: one Aurora DSQL cluster, one files S3 bucket, and one API Gateway are shared across all installed apps, with per-app PG roles and S3 prefixes providing isolation. See `roles-and-permissions.md` for the role / boundary model and the install delegation chain.

The customer-facing deployment flow is driven from the admin-web cloud setup wizard, which generates and deploys the bootstrap CloudFormation template (`packages/aws-bootstrap`). Subsequent app installs run through `packages/admin-installer`. The notes below cover the underlying AWS configuration the operator needs.

### 1. Configure AWS credentials

```bash
aws configure
```

Or set environment variables:

```bash
export AWS_ACCESS_KEY_ID=your-access-key
export AWS_SECRET_ACCESS_KEY=your-secret-key
export AWS_REGION=us-east-1
```

### 2. Run the cloud setup wizard

From the admin-web app, the cloud setup wizard generates the bootstrap CloudFormation template and deep-links the operator to the CloudFormation console to deploy it in their own AWS account. The template creates the Cognito pools, the four install-time IAM roles (admin-app, Manager, install-DDL, install-infra), the five permissions boundaries, the Pulumi state bucket, the artifacts bucket, and a placeholder Pulumi state passphrase SSM parameter.

### 3. Deploy the cloud-data-server and install apps

After bootstrap, the admin app deploys the cloud-data-server (which provisions the DSQL cluster, files bucket, protocol-core Lambda, and shared API Gateway) and then installs each app via `packages/admin-installer`. App Lambda bundles are uploaded to the artifacts bucket created by bootstrap.

> **Note:** Aurora DSQL availability varies by region. As of early 2026, it is available in `us-east-1`, `us-east-2`, and `eu-west-1`. Check [AWS DSQL documentation](https://docs.aws.amazon.com/aurora-dsql/) for current region availability.

---

## Project Structure

```
packages/
  core/                  # Identifiers (ULID), HLC, records, schema validation
  storage-adapter/       # Abstract interfaces + mock implementations
  storage-sqlite/        # SQLite adapter (local, uses node:sqlite)
  storage-aurora-dsql/   # Aurora DSQL adapter (cloud)
  storage-s3/            # S3 object storage adapter
  storage-fs/            # Local filesystem object storage
  metadata-engine/       # Generator registry, dependency graph, generation queue
  metadata-core/         # Built-in generators (image dimensions, file properties)
  index/                 # Unified query orchestrator
  aggregations/          # Counts, sizes, date histograms
  sync-engine/           # Bidirectional sync with HLC conflict resolution
  access-control/        # Policy model, enforced adapter wrapper
  shared-space-api/      # Versioned API router and middleware
  sdk/                   # High-level facade over all packages

examples/
  photo-app/             # Google Photos-like app (React + Vite)
  ai-assistant/          # Conversation-based AI UI (React + Vite)
  admin-panel/           # Deployment + permissions dashboard (React + Vite + Tauri)
```

---

## Available Scripts

```bash
pnpm build              # Build all packages (via Turborepo)
pnpm test               # Run all tests
pnpm typecheck          # Type-check all packages
pnpm lint               # Lint all packages
pnpm format             # Format with Prettier
pnpm format:check       # Check formatting
```
