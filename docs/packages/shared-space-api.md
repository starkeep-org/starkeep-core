# @starkeep/shared-space-api

A lightweight HTTP API framework for exposing protocol data through versioned, namespaced
endpoints. Routes are registered by namespace and version, so multiple apps can share
a single API Gateway without collision.

Access through the SDK as `sdk.api`.

## Registering endpoints

```typescript
import { createSharedSpaceApi } from "@starkeep/shared-space-api"

const api = createSharedSpaceApi({
  databaseAdapter,
  objectStorageAdapter,
  clock,
  ownerId: "user-123",
})

api.router.register({
  namespace: "tasks",
  version: "v1",
  path: "/tasks",
  method: "GET",
  description: "List all tasks",
  handler: async (request, context) => {
    const results = await context.databaseAdapter.query({
      type: "tasks:task",
      sort: [{ field: "updatedAt", direction: "desc" }],
      limit: 50,
    })
    return { status: 200, body: results }
  },
})
```

Endpoints are accessible at `/<namespace>/<version>/<path>` — in this example,
`GET /tasks/v1/tasks`.

## Handling requests

```typescript
const response = await api.handleRequest({
  path: "/tasks/v1/tasks",
  method: "GET",
  query: { limit: "20" },
  headers: { authorization: "Bearer ..." },
  subject: { subjectType: "user", subjectId: "user-123" },
})

response.status   // HTTP status code
response.body     // response payload
response.headers  // response headers
```

## Handler context

Each handler receives the registered `context`:

| Property | Type | Description |
|----------|------|-------------|
| `databaseAdapter` | `DatabaseAdapter` | Database access |
| `objectStorageAdapter` | `ObjectStorageAdapter` | File storage access |
| `clock` | `HLCClock` | HLC clock for creating timestamps |
| `ownerId` | `string` | Owner identifier |

## Pagination helpers

```typescript
import { parseQueryParams, formatPaginatedResponse } from "@starkeep/shared-space-api"

// In a handler:
const { limit, cursor } = parseQueryParams(request.query)
const results = await context.databaseAdapter.query({ limit, cursor })
return { status: 200, body: formatPaginatedResponse(results) }
```

## Error types

```typescript
import { ApiError, RouteNotFoundError, MethodNotAllowedError } from "@starkeep/shared-space-api"
```
