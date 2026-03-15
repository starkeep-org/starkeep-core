# @starkeep/aws-provider

Pulumi Automation API-based provider for per-user AWS resource provisioning. Manages Aurora DSQL clusters, S3 buckets, and API Gateway endpoints for each user.

## Installation

```bash
pnpm add @starkeep/aws-provider
```

## Usage

```ts
import { createAwsProvider } from "@starkeep/aws-provider";

const awsProvider = createAwsProvider({
  projectName: "starkeep-production",
  region: "us-east-1",
  stateBackend: "s3",
});

// Provision resources for a user
const provisionedResources = await awsProvider.provisionUser({
  userId: "user-123",
  region: "us-east-1",
});

console.log(provisionedResources.auroraEndpoint);
console.log(provisionedResources.s3BucketName);
console.log(provisionedResources.apiGatewayUrl);

// Get existing resources for a user
const existingResources = await awsProvider.getResources("user-123");

// List all provisioned users
const userIds = await awsProvider.listUsers();

// Deprovision a user's resources
const deprovisionResult = await awsProvider.deprovisionUser("user-123");
console.log(deprovisionResult.resourcesRemoved);
```

### Resource naming utilities

```ts
import { buildBucketName, buildClusterIdentifier, buildStackName, parseStackName } from "@starkeep/aws-provider";

const bucketName = buildBucketName("starkeep-production", "user-123");
const clusterIdentifier = buildClusterIdentifier("starkeep-production", "user-123");
const stackName = buildStackName("starkeep-production", "user-123");
const { projectName, userId } = parseStackName(stackName);
```

### Testing with the mock stack program

```ts
import { createMockStackProgram } from "@starkeep/aws-provider";

const mockStackProgram = createMockStackProgram();
// Use in tests to simulate Pulumi stack operations without real AWS resources
```

## API

### Factory Functions

| Function | Description |
|---|---|
| `createAwsProvider(options)` | Creates an `AwsProvider` for managing per-user infrastructure |
| `createMockStackProgram()` | Creates a mock `StackProgram` for testing without real AWS calls |
| `buildBucketName(projectName, userId)` | Generate a deterministic S3 bucket name |
| `buildClusterIdentifier(projectName, userId)` | Generate a deterministic Aurora DSQL cluster identifier |
| `buildStackName(projectName, userId)` | Generate a Pulumi stack name from project and user |
| `parseStackName(stackName)` | Parse a stack name back into project name and user ID |

### `AwsProvider`

| Method | Description |
|---|---|
| `provisionUser(options)` | Provision AWS resources (Aurora DSQL, S3, API Gateway) for a user |
| `deprovisionUser(userId)` | Tear down all provisioned resources for a user |
| `getResources(userId)` | Retrieve provisioned resource details for a user, or `null` if not provisioned |
| `listUsers()` | List all user IDs with provisioned resources |

### Key Types

| Type | Description |
|---|---|
| `AwsProviderOptions` | Configuration: project name, AWS region, state backend (`"local"` or `"s3"`) |
| `UserProvisioningOptions` | Provisioning input: user ID, region, optional stack name |
| `ProvisionedResources` | Output: Aurora endpoint, S3 bucket, API Gateway URL, region, stack outputs |
| `DeprovisionResult` | Deprovisioning output: user ID and list of removed resources |
| `StackProgram` | Interface for Pulumi stack operations (`up`, `destroy`, `getOutputs`, `listStacks`) |

## Testing

```bash
pnpm --filter @starkeep/aws-provider test
```
