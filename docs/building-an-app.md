# Building an App

## Choose an App Pattern

There are two ways to build on Starkeep:

**SDK-embedded** — Your app bundles the SDK directly and manages its own local and cloud adapters. Best for standalone apps (like a task manager) that don't need to share data with other local apps.

**Thin-client to data-server** — Your app is an HTTP client that talks to a running data-server instance. The data server owns the type registry and storage. Best for apps that share data with other local apps, or for web/mobile clients that can't embed a Node.js SDK (like the photos web app).

## Define Your Record Types

Every record belongs to a type. Types are declared in `namespace:name` format (e.g., `my-app:note`, `my-app:tag`) and registered at initialization time.

When defining a type, you supply a schema that describes the shape of the record's payload. The schema is validated on every write, so invalid data is rejected before it enters storage.

Best practices:
- Use a new type for each distinct kind of data (notes are not tags, even if they look similar)
- Keep payloads small — computed or derived fields belong in metadata, not in the record payload
- See [Data vs. Metadata App Architecture](data-vs-metadata-app-architecture.md) for guidance on the boundary

## Store and Retrieve Records

Once types are registered, you can create records with or without file attachments. For example, a photo record would be created with the image file attached; a note record would have no attachment.

Records can be:
- **Read by ID** — fetch a single known record
- **Queried** — filter by type, date range, payload fields, or metadata fields; sort and paginate results
- **Updated** — replace the payload (and optionally the file) of an existing record
- **Deleted** — remove a record and its associated metadata and file

## Add Metadata Generators

Generators compute derived properties from records. They run after a record is created or updated, and their output is stored as metadata records that reference the source record.

**Built-in generators** cover common cases:
- Image dimensions (width, height, orientation)
- File properties (MIME type, file size)
- Text preview (first N characters of a text field)

**Custom generators** let you add any derived property your app needs. A generator declares:
- Which record types it applies to
- Which payload fields it reads (used for cache invalidation via input hashing)
- What metadata fields it produces
- Whether it is **syncable** — meaning its output is non-deterministic (e.g., an AI-generated caption) and must be synced rather than recomputed on each device

The metadata engine resolves generator dependencies, runs them in the correct order, and skips generation when inputs haven't changed.

Generators run either on-demand (immediately after a record is written) or queued (processed in the background). Choose queued for expensive operations like AI inference.

## Search and Query

Starkeep provides a unified query interface that joins data and metadata records, so you can filter on both in the same query.

You can:
- Filter records by type, owner, date range, or payload fields
- Filter by metadata fields (e.g., only photos with width ≥ 1920)
- Run full-text search across payload fields
- Paginate results using cursors
- Filter to only sync-eligible records (useful for sync status UIs)

## Aggregations

Aggregations give you summary statistics over a set of records without fetching individual records:

- **Counts** — total records, broken down by type or MIME type
- **Storage totals** — total bytes stored, with per-type breakdowns
- **Date histograms** — record counts grouped by day, week, month, or year

Aggregation results are cached and updated incrementally as records change, so they're fast even over large datasets.

## Sync

Sync is enabled by providing both local and remote adapters when initializing the SDK. If only local adapters are provided, the SDK operates in local-only mode.

When sync is enabled:
- Call a full sync to pull remote changes and push local changes
- Listen for change events to update the UI in real time when records are added, updated, or deleted locally or remotely
- Records marked as local-only are never included in sync

Conflicts — records modified both locally and remotely since the last sync — are resolved automatically using HLC timestamps. The record with the higher timestamp wins. Apps don't need to implement conflict resolution logic.

## Access Control

Access control is configured by creating policies. A policy specifies:
- **Subject** — who is being granted access: a user (by ID), an app, or a sharing token
- **Resource** — what they can access: a specific record, all records of a type, or a named collection
- **Permissions** — what they can do: read, write, delete, or admin

Policies are enforced at the storage layer on every operation, regardless of how the operation was initiated.

**Sharing tokens** are credentials that encode a specific set of permissions and can be shared with external users or services. You can set an expiration date and a maximum number of uses. Once a token is used or expired, it is no longer accepted.

## Expose an HTTP API

If your app needs to serve data over HTTP (for web clients, mobile clients, or inter-app communication), you can register API routes using the shared-space API framework.

Routes are namespaced and versioned (e.g., `GET /my-app/v1/notes`). You register handlers for each route, and the framework handles:
- Routing by namespace, path, and HTTP method
- Subject resolution from the incoming request (mapping auth credentials to a subject)
- Query parameter parsing
- Paginated response formatting

The data server uses this same framework for its own routes, so your custom routes integrate cleanly alongside the built-in ones.

## Thin-Client Pattern

In the thin-client pattern, your app talks to a data-server instance over HTTP instead of embedding the SDK. The app sends authenticated requests, and the data server applies access control and returns results.

This is how the photos web app works: the Next.js server makes requests to the local data server, which holds the type registry and storage. The web client never touches the SDK directly.

For thin clients:
- Use auth tokens (Cognito JWTs) for all requests to the data server
- The data server enforces access control on every request
- Custom API routes registered on the data server are available to thin clients too

## AWS Permissions Management

If your app requires additional AWS resources or permissions:

1. Edit the template in packages/admin-core/src/self-hosted-permissions-template.ts
2. Run `pnpm build` from packages/admin-core to render the new template file
3. In the admin-web app, go to the Deploy permissions tab and click Update permissions stack