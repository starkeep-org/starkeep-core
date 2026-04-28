# Infrastructure

Starkeep provisions isolated AWS infrastructure for each user via the Pulumi Automation API.
Every user gets their own database, file storage, and API endpoint — no shared resources.

## What gets provisioned per user

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

| Resource | Purpose |
|----------|---------|
| **Aurora DSQL cluster** | User's primary database. PostgreSQL-compatible, serverless. |
| **S3 bucket** | User's file storage for file-backed records. |
| **API Gateway** | HTTP entrypoint for the user's Shared Space API. |
| **IAM roles** | Scoped permissions for the API handlers to access DSQL and S3. |

## Provisioning a user

```typescript
import { createAwsProvider } from "@starkeep/aws-provider"

const provider = createAwsProvider(
  {
    projectName: "my-app",
    region: "us-east-1",
    stateBackend: "s3",
  },
  myStackProgram,
)

const resources = await provider.provisionUser({
  userId: "user-alice",
  region: "us-east-1",
})

// resources now contains:
resources.databaseHostname  // Aurora DSQL connection endpoint
resources.bucketName        // S3 bucket name
resources.apiEndpoint       // API Gateway URL
```

Use `resources.databaseHostname` to initialize `AuroraDsqlDatabaseAdapter` and
`resources.bucketName` to initialize `S3ObjectStorageAdapter` for this user's SDK.

## Retrieving existing resources

```typescript
const resources = await provider.getResources("user-alice")
if (resources) {
  // user is provisioned; initialize their SDK
} else {
  // user needs provisioning
}
```

## Listing provisioned users

```typescript
const users = await provider.listUsers()
// ["user-alice", "user-bob", ...]
```

## Deprovisioning a user

```typescript
await provider.deprovisionUser("user-alice")
// Destroys all AWS resources in the user's stack
```

## Pulumi state backends

| Backend | When to use |
|---------|------------|
| `"local"` | Development and local testing |
| `"s3"` | Production — stores Pulumi state in an S3 bucket |

For the S3 backend, configure the state bucket separately (it's shared infrastructure,
not per-user).

## Resource naming

All per-user resources follow deterministic naming conventions:

```typescript
import { buildStackName, buildBucketName, buildClusterIdentifier } from "@starkeep/aws-provider"

buildStackName("my-app", "alice")          // "my-app-user-alice"
buildBucketName("my-app", "alice")         // "my-app-alice-data"
buildClusterIdentifier("my-app", "alice")  // "my-app-alice-cluster"
```

Consistent naming means you can reconstruct resource names from a user ID without querying
Pulumi state.

## Requirements

- Pulumi CLI installed and authenticated
- AWS credentials with permissions to create IAM roles, Aurora DSQL, S3, and API Gateway
- For the S3 state backend: a bucket pre-created for Pulumi state storage

## Server apps and their roles

Three apps participate in data serving. Only one is deployed to AWS.

| App | Where it runs | Role |
|-----|---------------|------|
| `apps/data-server` | Local dev machine | Client-side sidecar for the desktop app. Stores data in local SQLite + filesystem. Exposes a REST API for apps and optionally syncs outward to the cloud endpoint. Handles Cognito auth and STS credential rotation. |
| `apps/cloud-server` | Local dev machine | Simulates the cloud server locally. Runs the `AuroraDsqlDatabaseAdapter` + `FsObjectStorageAdapter` backed by a local Postgres instance (port 5434) so the production adapter code path can be validated without provisioning real AWS infrastructure. |
| `infra/user-data/src/api-handler.ts` | AWS Lambda | The actual cloud server, deployed via SST. Uses the Lambda execution role for credentials (no credential management needed), real Aurora DSQL, and real S3. Fronted by API Gateway with a Cognito JWT authorizer. |

`cloud-server` is purely a dev tool — it is not referenced by any other app and nothing in the SST config deploys it. In a local dev setup, `data-server` can be pointed at `cloud-server` (via `STARKEEP_CLOUD_URL=http://127.0.0.1:9920`) to exercise the full sync path without real AWS.
