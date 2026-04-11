# @starkeep/access-control

Policy-based access control with cryptographic sharing tokens. Access is enforced
uniformly at the storage layer regardless of which code path accesses data.

Access through the SDK as `sdk.accessControl`.

## Creating and revoking policies

```typescript
// Grant user-456 read access to a collection
const policy = await sdk.accessControl.createPolicy({
  subjectType: "user",          // "user" | "app" | "api" | "token"
  subjectId: "user-456",
  resourceType: "collection",   // "item" | "type" | "collection" | "wildcard"
  resourceId: "vacation-album",
  permissions: ["read"],        // "read" | "write" | "delete" | "admin"
  expiresAt: someHLCTimestamp,  // optional
})

await sdk.accessControl.revokePolicy(policy.policyId)

const policies = await sdk.accessControl.listPolicies()
```

## Checking access

```typescript
const check = await sdk.accessControl.checkAccess({
  subjectType: "user",
  subjectId: "user-456",
  resourceId: photo.id,
  permission: "read",
})

check.allowed   // true | false
check.reason    // explanation string
```

## Sharing tokens

Sharing tokens let you give external parties access without creating a permanent user
account. A token is cryptographically tied to a policy.

```typescript
// Create a token
const { token, tokenId } = await sdk.accessControl.createSharingToken(policy.policyId, {
  maxUses: 10,         // optional usage limit
})

// Share `token` string externally

// Validate a received token
const resolvedPolicy = await sdk.accessControl.validateSharingToken(token)
if (resolvedPolicy) {
  // Grant access according to resolvedPolicy.permissions
}
```

Revoking the underlying policy also invalidates all tokens tied to it.

## Enforcement

The `EnforcedDatabaseAdapter` wrapper intercepts every database operation and checks it
against the applicable policy before forwarding. Import directly if you need to enforce
access at the adapter level outside the SDK:

```typescript
import { createEnforcedDatabaseAdapter } from "@starkeep/access-control"

const enforcedAdapter = createEnforcedDatabaseAdapter(
  baseAdapter,
  accessControlEngine,
  { subjectType: "user", subjectId: "user-123" },
)
```
