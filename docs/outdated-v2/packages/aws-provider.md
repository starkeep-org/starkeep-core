# @starkeep/aws-provider

Provisions and deprovisions per-user AWS infrastructure using the Pulumi Automation API.
Each user gets an isolated stack containing an Aurora DSQL cluster, an S3 bucket, an API
Gateway, and the necessary IAM roles.

This package is used by platform-level code (the service that manages user accounts), not
by individual apps or users.

## Usage

```typescript
import { createAwsProvider } from "@starkeep/aws-provider"

const provider = createAwsProvider(
  {
    projectName: "starkeep",
    region: "us-east-1",
    stateBackend: "s3",   // "local" | "s3"
  },
  stackProgram,  // your StackProgram implementation
)

// Provision infrastructure for a new user
const resources = await provider.provisionUser({
  userId: "user-alice",
  region: "us-east-1",
})

resources.databaseHostname  // Aurora DSQL endpoint
resources.bucketName        // S3 bucket name
resources.apiEndpoint       // API Gateway URL

// Retrieve existing resources
const resources = await provider.getResources("user-alice")

// List all provisioned users
const users = await provider.listUsers()

// Decommission a user's infrastructure
await provider.deprovisionUser("user-alice")
```

## StackProgram interface

You implement `StackProgram` to provide the actual Pulumi resource definitions.
The package provides `createMockStackProgram()` for testing.

## Naming utilities

```typescript
import { buildStackName, buildBucketName, buildClusterIdentifier } from "@starkeep/aws-provider"

buildStackName("starkeep", "alice")          // "starkeep-user-alice"
buildBucketName("starkeep", "alice")         // "starkeep-alice-data"
buildClusterIdentifier("starkeep", "alice")  // "starkeep-alice-cluster"
```

## Notes

- State can be stored locally (for development) or in S3 (for production)
- Pulumi must be installed and configured in the environment where this runs
- See [Infrastructure](../infrastructure.md) for the full provisioning workflow
