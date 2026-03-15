# @starkeep/access-control

Policy-based access control with subject/resource permissions, sharing tokens, and an enforced database adapter wrapper that gates all queries through policy checks.

## Installation

```bash
pnpm add @starkeep/access-control
```

## Usage

```ts
import { createAccessControlEngine, createEnforcedDatabaseAdapter } from "@starkeep/access-control";

const accessControlEngine = createAccessControlEngine(databaseAdapter, clock);

// Create a policy granting read/write access
const policy = await accessControlEngine.createPolicy({
  subjectType: "user",
  subjectId: "user-123",
  resourceType: "type",
  resourceId: "photo",
  permissions: ["read", "write"],
});

// Check access
const accessCheckResult = await accessControlEngine.checkAccess({
  subjectType: "user",
  subjectId: "user-123",
  resourceId: recordId,
  permission: "read",
});

if (accessCheckResult.allowed) {
  console.log("Access granted via policy:", accessCheckResult.matchedPolicy?.policyId);
}

// Generate a sharing token for a policy
const { token, tokenId } = await accessControlEngine.createSharingToken(policy.policyId, {
  expiresAt: expirationTimestamp,
  maxUses: 10,
});

// Validate a sharing token
const matchedPolicy = await accessControlEngine.validateSharingToken(token);

// Wrap a database adapter with automatic access enforcement
const enforcedAdapter = createEnforcedDatabaseAdapter(databaseAdapter, accessControlEngine, {
  subjectType: "user",
  subjectId: "user-123",
});
// All queries through enforcedAdapter are now gated by policy checks
```

## API

### Factory Functions

| Function | Description |
|---|---|
| `createAccessControlEngine(databaseAdapter, clock)` | Creates an `AccessControlEngine` for managing policies and tokens |
| `createEnforcedDatabaseAdapter(databaseAdapter, engine, subject)` | Wraps a `DatabaseAdapter` to enforce access checks on every operation |
| `resolvePolicy(policies, request)` | Resolves which policy (if any) grants access for a given request |
| `generateToken()` | Generates a cryptographically random sharing token string |
| `hashToken(token)` | Hashes a token for secure storage |

### `AccessControlEngine`

| Method | Description |
|---|---|
| `createPolicy(input)` | Create a new access policy |
| `revokePolicy(policyId)` | Revoke an existing policy |
| `listPolicies(options?)` | List policies, optionally filtered by subject or resource |
| `checkAccess(request)` | Check whether a subject has a specific permission on a resource |
| `createSharingToken(policyId, options?)` | Generate a sharing token tied to a policy |
| `validateSharingToken(token)` | Validate a token and return its associated policy, or `null` if invalid |

### Key Types

| Type | Description |
|---|---|
| `Permission` | `"read"` \| `"write"` \| `"delete"` \| `"admin"` |
| `SubjectType` | `"user"` \| `"app"` \| `"api"` \| `"token"` |
| `ResourceType` | `"item"` \| `"type"` \| `"collection"` \| `"wildcard"` |
| `AccessPolicy` | A policy record with subject, resource, permissions, and expiration |
| `CreatePolicyInput` | Input for creating a new policy |
| `AccessCheckRequest` | A permission check request specifying subject, resource, and permission |
| `AccessCheckResult` | Result with `allowed` flag, matched policy, and reason string |
| `SharingToken` | Token record with hash, policy ID, expiration, and usage tracking |
| `SharingTokenOptions` | Optional expiration and max uses for token creation |

### Errors

| Error | Description |
|---|---|
| `AccessDeniedError` | Thrown when an operation is blocked by the enforced adapter |
| `PolicyNotFoundError` | Thrown when referencing a non-existent policy |

## Testing

```bash
pnpm --filter @starkeep/access-control test
```
