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

Starkeep follows a **per-user isolation model**: each app user gets their own Aurora DSQL cluster, S3 bucket, and API Gateway. The `@starkeep/aws-provider` package orchestrates this via the Pulumi Automation API.

### Architecture overview

```
Per-user stack (provisioned by @starkeep/aws-provider):
┌──────────────────────────────────────────────────┐
│  API Gateway  ─────>  Lambda Functions           │
│                       (sync, metadata, API)      │
│                                                  │
│  Aurora DSQL  <────>  Data + Metadata Records    │
│  S3 Bucket    <────>  Files (photos, documents)  │
│                                                  │
│  IAM Roles + Security Groups                     │
└──────────────────────────────────────────────────┘
```

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

### 2. Configure Pulumi state backend

Pulumi needs somewhere to store infrastructure state. For a team or production setup, use S3:

```bash
pulumi login s3://your-pulumi-state-bucket
```

For local-only development:

```bash
pulumi login --local
```

### 3. Implement a real stack program

The `@starkeep/aws-provider` package defines a `StackProgram` interface that abstracts Pulumi operations. The repository ships with a `createMockStackProgram()` for testing. To deploy real infrastructure, you need to implement `StackProgram` backed by Pulumi.

Create a file at `infrastructure/stack-program.ts`:

```typescript
import { LocalWorkspace } from "@pulumi/pulumi/automation";
import type { StackProgram } from "@starkeep/aws-provider";

export function createPulumiStackProgram(
  projectDirectory: string,
): StackProgram {
  return {
    async up(stackName, config) {
      const stack = await LocalWorkspace.createOrSelectStack({
        stackName,
        workDir: projectDirectory,
      });

      for (const [key, value] of Object.entries(config)) {
        await stack.setConfig(key, { value });
      }

      const result = await stack.up({ onOutput: console.log });
      return Object.fromEntries(
        Object.entries(result.outputs).map(([key, output]) => [
          key,
          String(output.value),
        ]),
      );
    },

    async destroy(stackName) {
      const stack = await LocalWorkspace.selectStack({
        stackName,
        workDir: projectDirectory,
      });
      await stack.destroy({ onOutput: console.log });
    },

    async getOutputs(stackName) {
      try {
        const stack = await LocalWorkspace.selectStack({
          stackName,
          workDir: projectDirectory,
        });
        const outputs = await stack.outputs();
        if (Object.keys(outputs).length === 0) return null;
        return Object.fromEntries(
          Object.entries(outputs).map(([key, output]) => [
            key,
            String(output.value),
          ]),
        );
      } catch {
        return null;
      }
    },

    async listStacks() {
      const workspace = await LocalWorkspace.create({
        workDir: projectDirectory,
      });
      const stacks = await workspace.listStacks();
      return stacks.map((summary) => summary.name);
    },
  };
}
```

### 4. Define a Pulumi project for per-user stacks

Create an `infrastructure/` directory with a Pulumi project that provisions per-user resources. At minimum you need:

```
infrastructure/
  Pulumi.yaml          # Pulumi project definition
  index.ts             # Stack definition (Aurora DSQL + S3 + API Gateway)
  stack-program.ts     # StackProgram implementation (see above)
```

Example `infrastructure/Pulumi.yaml`:

```yaml
name: starkeep-user-stack
runtime:
  name: nodejs
  options:
    typescript: true
description: Per-user Starkeep infrastructure
```

Example `infrastructure/index.ts` (Pulumi stack definition):

```typescript
import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

const config = new pulumi.Config();
const userId = config.require("userId");
const region = config.require("region");

// S3 bucket for user's files
const bucket = new aws.s3.BucketV2(`starkeep-${userId}-data`, {
  bucket: `starkeep-${userId}-data`,
  tags: { userId, managedBy: "starkeep" },
});

new aws.s3.BucketServerSideEncryptionConfigurationV2(
  `starkeep-${userId}-encryption`,
  {
    bucket: bucket.id,
    rules: [
      {
        applyServerSideEncryptionByDefault: {
          sseAlgorithm: "AES256",
        },
      },
    ],
  },
);

new aws.s3.BucketPublicAccessBlock(`starkeep-${userId}-public-access`, {
  bucket: bucket.id,
  blockPublicAcls: true,
  blockPublicPolicy: true,
  ignorePublicAcls: true,
  restrictPublicBuckets: true,
});

// Aurora DSQL cluster for user's data
const cluster = new aws.dsql.Cluster(`starkeep-${userId}-cluster`, {
  deletionProtectionEnabled: false,
  tags: { userId, managedBy: "starkeep" },
});

// Exports (returned to @starkeep/aws-provider)
export const s3BucketName = bucket.bucket;
export const auroraEndpoint = cluster.endpoint;
export const auroraResourceArn = cluster.arn;
```

> **Note:** Aurora DSQL availability varies by region. As of early 2026, it is available in `us-east-1`, `us-east-2`, and `eu-west-1`. Check [AWS DSQL documentation](https://docs.aws.amazon.com/aurora-dsql/) for current region availability.

### 5. Provision a user

With the real stack program in place, provisioning a user from your application code:

```typescript
import { createAwsProvider } from "@starkeep/aws-provider";
import { createPulumiStackProgram } from "./infrastructure/stack-program.js";

const stackProgram = createPulumiStackProgram("./infrastructure");

const provider = createAwsProvider(
  { projectName: "starkeep", region: "us-east-1" },
  stackProgram,
);

// Provision a user's isolated infrastructure
const resources = await provider.provisionUser({
  userId: "user-abc-123",
  region: "us-east-1",
});

console.log(resources);
// {
//   userId: "user-abc-123",
//   auroraEndpoint: "cluster.cluster-xxxxx.us-east-1.dsql.amazonaws.com",
//   s3BucketName: "starkeep-user-abc-123-data",
//   apiGatewayUrl: "https://xxxxx.execute-api.us-east-1.amazonaws.com",
//   region: "us-east-1",
//   ...
// }
```

### 6. Connect the SDK to real AWS resources

Once a user is provisioned, connect the SDK to their cloud resources:

```typescript
import { createStarkeepSdk } from "@starkeep/sdk";
import { createS3ObjectStorageAdapter } from "@starkeep/storage-s3";
// Aurora DSQL adapter requires a DatabaseClientFactory implementation (see below)

const objectStorageAdapter = createS3ObjectStorageAdapter({
  bucketName: resources.s3BucketName,
  region: resources.region,
  // Credentials are resolved from the environment by default (AWS SDK v3)
});

const sdk = await createStarkeepSdk({
  databaseAdapter,       // Aurora DSQL adapter (see note below)
  objectStorageAdapter,
  ownerId: resources.userId,
  nodeId: "cloud-node",
});
```

> **Note on Aurora DSQL:** The `@starkeep/storage-aurora-dsql` package defines the adapter structure and query builder, but requires a `DatabaseClientFactory` implementation to connect. You need to provide a PostgreSQL client (e.g., using `pg` or `@aws-sdk/client-dsql`) that implements the `DatabaseClient` interface:
>
> ```typescript
> interface DatabaseClient {
>   query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
>   end(): Promise<void>;
> }
> ```

### 7. Deprovision a user

```typescript
const result = await provider.deprovisionUser("user-abc-123");
console.log(`Removed: ${result.resourcesRemoved.join(", ")}`);
```

---

## AWS Services and Estimated Costs

Per-user infrastructure costs (approximate, varies by usage):

| Service | Purpose | Cost driver |
|---------|---------|-------------|
| Aurora DSQL | Database (records, metadata) | Instance hours + I/O requests |
| S3 | File storage (photos, documents) | Storage GB + requests |
| API Gateway | HTTP endpoints | Requests + data transfer |
| Lambda | Compute (sync, metadata generation) | Invocations + duration |

For development/testing, costs are minimal. For production, Aurora DSQL is the primary cost driver.

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
  aws-provider/          # Pulumi-based per-user provisioning orchestration
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
