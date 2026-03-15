# @starkeep/shared-space-api

Versioned API router and request handler for shared spaces. Provides namespaced, versioned endpoint registration, routing, and pagination helpers.

## Installation

```bash
pnpm add @starkeep/shared-space-api
```

## Usage

```ts
import { createSharedSpaceApi, createApiRouter } from "@starkeep/shared-space-api";

const sharedSpaceApi = createSharedSpaceApi({
  databaseAdapter: myDatabaseAdapter,
  objectStorageAdapter: myObjectStorage,
  clock: hybridLogicalClock,
  ownerId: "user-123",
});

// Register a custom endpoint
sharedSpaceApi.router.register({
  namespace: "photos",
  version: "v1",
  path: "/albums",
  method: "GET",
  description: "List all albums",
  handler: async (request, context) => {
    const queryResult = await context.databaseAdapter.query({
      kind: "data",
      filters: [{ field: "type", operator: "eq", value: "album" }],
    });
    return { status: 200, body: queryResult.records };
  },
});

// Handle an incoming request
const response = await sharedSpaceApi.handleRequest({
  path: "/photos/v1/albums",
  method: "GET",
  subject: { subjectType: "user", subjectId: "user-456" },
  query: { limit: "20", cursor: "abc" },
});

console.log(response.status, response.body);
```

### Helpers

```ts
import { parseQueryParams, formatPaginatedResponse } from "@starkeep/shared-space-api";

// Parse standard query parameters
const parsedParameters = parseQueryParams({ limit: "25", cursor: "xyz", type: "photo" });

// Format a paginated API response
const paginatedResponse = formatPaginatedResponse(items, nextCursor, hasMore);
```

## API

### Factory Functions

| Function | Description |
|---|---|
| `createSharedSpaceApi(options)` | Creates a `SharedSpaceApi` with a router and request handler |
| `createApiRouter()` | Creates a standalone `ApiRouter` for endpoint registration and resolution |
| `parseQueryParams(query)` | Parses query string parameters into typed values |
| `formatPaginatedResponse(items, cursor, hasMore)` | Formats items into a standard paginated response shape |

### `SharedSpaceApi`

| Member | Description |
|---|---|
| `router` | The `ApiRouter` instance for registering and listing endpoints |
| `handleRequest(request)` | Route and handle an incoming `ApiRequest`, returning an `ApiResponse` |

### `ApiRouter`

| Method | Description |
|---|---|
| `register(endpoint)` | Register a versioned endpoint definition |
| `resolve(namespace, version, path, method)` | Look up a registered endpoint |
| `listEndpoints()` | List all registered endpoint definitions |

### Key Types

| Type | Description |
|---|---|
| `SharedSpaceApiOptions` | Configuration: database adapter, object storage adapter, HLC clock, owner ID |
| `ApiEndpointDefinition` | Endpoint registration with namespace, version, path, method, and handler |
| `ApiRequest` | Incoming request with path, method, body, query, headers, and subject |
| `ApiResponse` | Response with status code, body, and optional headers |
| `ApiSubject` | Request subject with type and ID |
| `ApiHandler` | Async function `(request, context) => ApiResponse` |
| `ApiContext` | Handler context with database adapter, object storage, clock, and owner ID |
| `PaginatedApiResponse` | Standard paginated response shape |
| `ParsedQueryParams` | Parsed query parameters object |

### Errors

| Error | Description |
|---|---|
| `ApiError` | Base error for API failures |
| `RouteNotFoundError` | No matching endpoint for the given path and method |
| `MethodNotAllowedError` | Endpoint exists at path but not for the given HTTP method |

## Testing

```bash
pnpm --filter @starkeep/shared-space-api test
```
