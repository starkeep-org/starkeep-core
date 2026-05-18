# Building an App

## The Manifest

Every Starkeep app starts with a `manifest.json`. The manifest is the spec — it declares what infrastructure your app needs, and the admin-installer provisions exactly that. You can't request capabilities outside the manifest schema.

```json
{
  "name": "my-app",
  "version": "1.0.0",
  "description": "What this app does",
  "infraRequirements": {
    "sharedTypeAccess": [
      {
        "typeId": "image",
        "access": "read",
        "metadataWrite": false,
        "rationale": "Display the user's photos"
      }
    ],
    "compute": {
      "enabled": false,
      "handlers": []
    },
    "brokerPower": false,
    "canIngestUnknown": false,
    "canPromoteFromUnknown": false
  }
}
```

When an admin installs your app, the installer reads this manifest and:
- Creates an IAM role scoped exactly to what you declared
- Creates a PostgreSQL role and private schema for your app
- Grants your PG role read or readwrite access to the shared type tables you declared
- Writes `shared.access_grants` rows so the protocol-core knows what to include in your sync responses
- Optionally provisions Lambda functions and API Gateway routes (if `compute.enabled: true`)

## Shared Type Access

Starkeep has a fixed set of core types: `image`, `markdown` (and others defined in the core type registry). Apps access these shared types by declaring them in `sharedTypeAccess`.

- `access: "read"` — read records and their metadata for this type
- `access: "readwrite"` — also create, update, and delete records
- `metadataWrite: true` — also write to the per-type metadata table (e.g., to attach thumbnail dimensions)

You cannot define new types. If your data doesn't fit a core type, use `unknown` (see below) or store it in your app-private schema.

### The Unknown Type

Apps that receive files of an unknown format can ingest them as type `unknown` by requesting `canIngestUnknown: true` in the manifest. Unknown records sit in a holding pen until an authorized app promotes them to a typed record (`canPromoteFromUnknown: true`). Promotion is audited in `shared.reclassifications`.

## App-Specific Syncable Data

If your app needs its own database tables or files, declare them in
`appSpecificSyncable`. The installer materializes the declared tables as
`<appId>_syncable_<name>` and, if `files: true`, enables the object-storage
prefix `apps/<appId>/syncable/...`. Both are accessible only to your app and
sync as a unit to other locations where your app is installed.

There is no system-provided namespace for app-private non-syncable data —
anything outside `shared/...` and `apps/<appId>/syncable/...` is your app's
own responsibility.

## Compute (Lambda + API Gateway)

If your app needs server-side compute, declare `compute.enabled: true` and list your handlers:

```json
"compute": {
  "enabled": true,
  "handlers": [
    {
      "name": "api",
      "handler": "dist/handler.api",
      "memoryMb": 256,
      "timeoutSeconds": 30,
      "routes": ["GET /items", "POST /items"],
      "env": {}
    }
  ]
}
```

The installer provisions each handler as a Lambda function (`${stackPrefix}-app-${appId}-${name}`) and attaches routes to the shared API Gateway under `/apps/${appId}/`. Your Lambda's execution role is the app's IAM role — it has the same S3 and DSQL access as any other request from your app.

Your dist.zip must be uploaded to `apps/${appId}/latest/dist.zip` in the artifacts bucket before install (the installer reads it from there).

## Broker Power

Apps that need to access other apps' data on behalf of a request — like the data-server acting as a protocol broker — can request `brokerPower: true`. A broker app's role can assume other per-app roles. This is a privileged capability; normal apps don't need it.

## Choose an App Pattern

**Web app using the protocol-core Lambda:** Most apps. Make authenticated requests to `${apiGatewayUrl}/apps/${appId}/data/...` with a Cognito JWT. The Lambda handles per-app role assumption and routes you to your scoped data.

**App with Lambda compute:** Apps that need server-side processing (thumbnail generation, AI inference, webhooks). Declare compute handlers in the manifest; they are provisioned at install time.

**Thin-client to local data-server:** For local development. Make HTTP requests to the data-server (port 9820) instead of the cloud Lambda.

## Store and Retrieve Records

Once installed, your app's data access goes through the protocol-core Lambda (cloud) or data-server (local). The API surface is consistent:

- `POST /apps/${appId}/data/records` — create a record
- `GET /apps/${appId}/data/records` — list records (filter by type, date, cursor)
- `GET /apps/${appId}/data/records/:id` — fetch one record
- `PUT /apps/${appId}/data/records/:id` — update a record
- `DELETE /apps/${appId}/data/records/:id` — delete a record
- `GET /apps/${appId}/data/records/:id/file-url` — presigned S3 GET URL

Records are typed payloads. Your app can only create/update records of the types it declared `readwrite` access to in the manifest.

## Sync

Sync moves records between local (SQLite) and cloud (DSQL). When cloud sync is enabled on the data-server:

- Records you can access appear in sync responses
- Records from other apps appear if you have read access to their type
- The `origin_app_id` field on each record tells you which app created it

Conflicts are resolved automatically using HLC timestamps. The record with the higher timestamp wins.

## Development Workflow

1. Write `manifest.json`
2. Implement your app (web UI, Lambda handlers, or both)
3. Build a `dist.zip` with your Lambda handlers (if compute enabled)
4. Upload the zip to the artifacts bucket: `apps/${appId}/latest/dist.zip`
5. Install through admin-web — the installer runs the state machine and provisions all declared resources
6. Test against the live cloud resources

On uninstall, all provisioned resources are cleaned up: IAM role, PG role, private schema, S3 objects, Lambda functions, and API Gateway routes.
