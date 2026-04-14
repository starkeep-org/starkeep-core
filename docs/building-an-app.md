# Building an App

This walkthrough uses the Tasks app as a reference. The Tasks app is a full implementation
of an app built on the Starkeep protocol — a task management tool available as both a web
app (Next.js) and a desktop app (Tauri), sharing the same data model and UI components.

The patterns shown here apply to any app you build on Starkeep.

## 1. Define your data types

Start by deciding what types of records your app needs. Types are namespaced strings in
the form `namespace:name`. Register them in a type registry with a payload schema:

```typescript
import { createTypeRegistry } from "@starkeep/core"
import * as v from "valibot"

const registry = createTypeRegistry()

registry.register({
  namespace: "tasks",
  name: "task",
  schema: v.object({
    title: v.string(),
    description: v.optional(v.string()),
    status: v.union([
      v.literal("blocked"),
      v.literal("backlog"),
      v.literal("todo"),
      v.literal("in-progress"),
      v.literal("done"),
    ]),
    assignee: v.optional(v.string()),
    labels: v.array(v.string()),
  }),
})

registry.register({
  namespace: "tasks",
  name: "group",
  schema: v.object({
    name: v.string(),
    description: v.optional(v.string()),
  }),
})
```

## 2. Write domain functions

Wrap SDK calls in typed domain functions that enforce your application's business rules.
These become the API surface used by your UI and API handlers.

```typescript
// tasks-lib/src/tasks.ts
import type { StarkeepSdk } from "@starkeep/sdk"

export async function createTask(
  sdk: StarkeepSdk,
  input: { title: string; groupId: string; ownerId: string },
) {
  return sdk.data.put({
    type: "tasks:task",
    ownerId: input.ownerId,
    payload: {
      title: input.title,
      groupId: input.groupId,
      status: "backlog",
      labels: [],
    },
  })
}

export async function updateTaskStatus(
  sdk: StarkeepSdk,
  taskId: string,
  status: string,
) {
  const existing = await sdk.data.get(taskId)
  if (!existing) throw new Error("Task not found")

  return sdk.data.put({
    ...existing,
    payload: { ...existing.payload, status },
  })
}

export async function searchTasks(
  sdk: StarkeepSdk,
  options: { groupId?: string; assignee?: string; fullText?: string },
) {
  const filters = []

  if (options.groupId) {
    filters.push({
      generatorId: "tasks:task-meta",
      field: "groupId",
      operator: "eq" as const,
      value: options.groupId,
    })
  }

  return sdk.index.search({
    types: ["tasks:task"],
    metadataFilters: filters,
    fullTextSearch: options.fullText,
    limit: 100,
  })
}
```

## 3. Write custom metadata generators

Metadata generators derive structured information from your records. In the Tasks app,
a generator extracts searchable task fields into metadata records, and another uses
Claude to suggest task importance.

```typescript
import type { GeneratingFunctionDefinition } from "@starkeep/metadata-engine"

// Extract fields for efficient querying
const taskMetaGenerator: GeneratingFunctionDefinition = {
  generatorId: "tasks:task-meta",
  generatorVersion: 1,
  inputTypes: ["tasks:task"],
  dependsOn: [],
  async generate(input, context) {
    const record = await context.databaseAdapter.get(input.dataRecordId)
    const payload = record?.payload ?? {}
    return {
      value: {
        groupId: payload.groupId,
        assignee: payload.assignee,
        status: payload.status,
        labelCount: (payload.labels as string[] ?? []).length,
      },
    }
  },
}
```

Register generators when initializing the SDK:

```typescript
const sdk = await createStarkeepSdk({
  // ...
  generators: [taskMetaGenerator],
})
```

## 4. Integrate sync into your app lifecycle

Call `fullSync()` when the app starts and when it resumes from background. Subscribe to
sync events to update the UI when remote changes arrive.

```typescript
// On app start
await sdk.sync?.fullSync()

// Subscribe to remote updates
const unsubscribe = sdk.sync?.onUpdate((event) => {
  if (event.eventType === "remote-update-available") {
    // Refetch or invalidate affected records in your UI
    refreshTaskList(event.recordIds)
  }
})

// On app close
unsubscribe?.()
await sdk.close()
```

For the desktop app, sync runs automatically in the background via a Rust sidecar process.
For the web app, sync happens on page load and when the user explicitly requests it.

## 5. Add access control

Control who can read or modify a user's task groups. The Tasks app uses policies to
allow collaborators read access to shared groups.

```typescript
// Owner shares a group with a collaborator
const policy = await sdk.accessControl.createPolicy({
  subjectType: "user",
  subjectId: collaboratorUserId,
  resourceType: "collection",
  resourceId: groupId,
  permissions: ["read"],
})

// Generate a shareable invite token
const { token } = await sdk.accessControl.createSharingToken(policy.policyId, {
  maxUses: 1,
})

// Collaborator validates the token and joins
const resolvedPolicy = await sdk.accessControl.validateSharingToken(token)
```

## 6. Expose an HTTP API

Use `@starkeep/shared-space-api` to expose your domain operations as versioned HTTP
endpoints. This is how the Tasks web app's Next.js API routes and the desktop app's
local HTTP server are structured.

```typescript
sdk.api.router.register({
  namespace: "tasks",
  version: "v1",
  path: "/tasks",
  method: "POST",
  description: "Create a task",
  handler: async (request, context) => {
    const task = await createTask(sdk, {
      title: request.body.title,
      groupId: request.body.groupId,
      ownerId: context.ownerId,
    })
    return { status: 201, body: task }
  },
})

sdk.api.router.register({
  namespace: "tasks",
  version: "v1",
  path: "/tasks/search",
  method: "GET",
  description: "Search tasks",
  handler: async (request, context) => {
    const results = await searchTasks(sdk, {
      groupId: request.query?.groupId,
      fullText: request.query?.q,
    })
    return { status: 200, body: results }
  },
})
```

## 7. Share UI components across web and desktop

The Tasks app extracts all React components into a shared `@tasks/tasks-ui` package
that both `tasks-web` and `tasks-desktop` import. Both apps call the same domain
functions from `@tasks/tasks-lib`; only the storage adapters differ.

```
tasks-ui/          React components, hooks, styles
tasks-lib/         Domain functions, type definitions, SDK integration
tasks-web/         Next.js app — uses Aurora DSQL + S3
tasks-desktop/     Tauri app — uses SQLite + local FS
```

This separation keeps business logic and UI framework-agnostic. Swapping the backend
from local to cloud is done entirely at the SDK initialization layer.

## Reference app

The full Tasks app source is in:

- `apps/tasks-packages/tasks-lib/` — domain logic and type definitions
- `apps/tasks-packages/tasks-ui/` — shared React components
- `apps/tasks-web/` — Next.js web application
- `apps/tasks-desktop/` — Tauri desktop application

---

## Building a data-server-backed local app

The Tasks app walkthrough above describes embedding the SDK directly in the app process.
This works well for a single app with its own isolated storage. But when multiple local apps
on the same machine need to share data — for example, a desktop photos app and a Finder
extension both seeing the same photos — each app should instead be a **thin HTTP client to
the data-server**.

The photos app (`apps/photos-desktop`) is the reference implementation of this pattern.

### 1. Export type definitions from your app package

Define your record types in your app library package, and export them so the data-server
can import and register them:

```typescript
// photos-lib/src/manifest.ts
export const IMAGE_RECORD_TYPE = "@starkeep/image";
```

Data types use a global namespace (e.g., `@starkeep/image`) because they are meant to be
shared across apps. The file-provider, the photos app, and any future app that understands
images all use the same type string.

### 2. Register types in the data-server

The data-server is the authoritative type registry. Import type definitions from app
packages and register them at startup:

```typescript
// data-server/server.ts
import { createTypeRegistry } from "@starkeep/core"
import * as v from "valibot"

const typeRegistry = createTypeRegistry()
typeRegistry.register({
  namespace: "@starkeep",
  name: "image",
  schema: v.object({
    fileName: v.optional(v.string()),
    title: v.optional(v.string()),
  }),
})
// pass typeRegistry to createStarkeepSdk when the SDK option is available
```

### 3. Write a typed HTTP client in your app

Instead of initializing the SDK, write a small client that calls the data-server:

```typescript
// photos-desktop/src/lib/data-server-client.ts
const DATA_SERVER_URL = "http://127.0.0.1:9820";

export async function addPhoto(fileBytes: Uint8Array, mimeType: string, fileName: string) {
  const fileBase64 = uint8ToBase64(fileBytes);
  const res = await fetch(`${DATA_SERVER_URL}/data/records`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "@starkeep/image",
      payload: { fileName },
      fileName,
      contentType: mimeType,
      fileBase64,
    }),
  });
  const { record } = await res.json();
  return record;
}

export async function listPhotos() {
  const res = await fetch(`${DATA_SERVER_URL}/data/records?type=%40starkeep%2Fimage`);
  const { records } = await res.json();
  return records;
}
```

### 4. Run generators in the app, push results to the data-server

Generators are defined in your app package. In the thin-client pattern they run in the app
process using the raw bytes — no SDK context needed. Push the results via `POST /data/metadata`:

```typescript
import exifr from "exifr";

async function runGenerators(recordId: string, fileBytes: Uint8Array, fileName: string) {
  // EXIF — exifr.parse() works on raw bytes in the browser
  const exif = await exifr.parse(fileBytes, { pick: ["DateTimeOriginal", "Make", "Model", ...] });
  await fetch(`${DATA_SERVER_URL}/data/metadata`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      targetId: recordId,
      targetType: "@starkeep/image",
      generatorId: "@photos/app:exif",
      generatorVersion: 1,
      value: { dateTakenRaw: exif?.DateTimeOriginal ?? null, cameraMake: exif?.Make ?? null, ... },
    }),
  });

  // Provenance
  await fetch(`${DATA_SERVER_URL}/data/metadata`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      targetId: recordId, targetType: "@starkeep/image",
      generatorId: "@photos/app:provenance", generatorVersion: 1,
      value: { originalFilename: fileName, googlePhotosId: null, sourceImageId: null },
    }),
  });
}
```

### 5. Cross-app visibility

Any other app that calls the data-server will immediately see the new record:

```
GET /data/records?type=%40starkeep%2Fimage     → photos app list view
GET /browse?path=/                             → file-provider root (shows Library)
GET /browse?path=/library-type:@starkeep/image → file-provider photo listing
GET /data/records/:id/file-url                 → signed URL to download the file
```

The `GET /browse` hierarchy is how the Finder file-provider navigates the data-server.
Records that are not associated with a watched directory appear under `Library →
<type-name>`. Files are named using `payload.title`, `payload.name`, `payload.fileName`,
or the record ID as a fallback, plus the extension derived from the MIME type.
