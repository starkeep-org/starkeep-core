# Align `/app-data/files/*` with shared data's direct-to-S3 presigned flow

The 2026-06-10 cloud-side app-data work added
`PUT|GET|DELETE /apps/{appId}/app-data/files/<key>` handlers that
**push bytes through API Gateway and the Lambda**: the broker reads
`event.body`, decodes from base64 if needed, calls
`view.putFile(subKey, bytes, mimeType)`, and the factory writes to S3
from inside the request. GET symmetrically requires the Lambda to
hold the file (or at least metadata) before issuing a redirect.

This is **the wrong shape**. Shared data already settled the right
pattern: client calls `POST /apps/{appId}/files/presign` to get a
signed S3 URL, then PUTs/GETs **directly against S3**, bypassing API
Gateway and the Lambda entirely. The broker only signs URLs; it never
sees the bytes. That's why shared data has no practical size ceiling
(5 GB single-PUT, multipart above).

App-private bytes are not different from shared bytes from a storage
perspective — same S3 bucket, just a different key prefix
(`apps/<appId>/syncable/...` instead of `shared/<category>/...`).
They should ride the same direct-to-S3 mechanism.

## Why this is top priority

- **Hard ceiling today: ~10 MB per file** (API Gateway HTTP API
  request-body cap). The handler's 20 MB constant is misleading; APIGW
  rejects before the broker runs.
- **Every app-private file write costs Lambda RAM and APIGW bandwidth
  twice** (once on the way in to the broker, once on the way out to
  S3). At scale this is real money for no benefit.
- **Inconsistent with the rest of the data plane.** Two parallel
  upload mechanisms for what is fundamentally the same operation —
  "PUT bytes into the user's S3 bucket under an app-scoped key" — is a
  source of ongoing maintenance and reasoning burden.
- **Forecloses real use cases.** Any cloud-served app that needs to
  store an app-private file larger than ~10 MB (a model weight, an
  exported archive, a media file) cannot do so under the current
  shape.

## Fix shape

Mirror the shared-data flow for app-data:

1. Add `POST /apps/{appId}/app-data/files/presign` (or extend
   `/files/presign` to accept app-data keys) that returns a presigned
   S3 PUT URL scoped to `apps/<appId>/syncable/<subKey>`. Same
   manifest gate the current handler enforces (refuses ops when the
   app didn't declare `appSpecificSyncable.files`).
2. Add `GET /apps/{appId}/app-data/files/<key>/presign` that returns
   a presigned S3 GET URL (clamped to remaining STS session lifetime
   minus the existing 30s buffer — the current handler already has
   `clampPresignExpiresIn`).
3. Migrate `shared-space-api`'s `AppSpecificOperations.putFile` /
   `getFile` shape, or add new presign-returning siblings, so client
   code can opt into the direct flow.
4. Once clients are migrated, deprecate the body-through PUT/GET on
   `/app-data/files/<key>` — keep the DELETE route (small, no bytes).

## Coordination notes

- The per-app IAM role's runtime policy already permits
  `s3:PutObject` / `s3:GetObject` on `apps/<appId>/syncable/*`
  (see `packages/admin-installer/src/temp-policies.ts`
  `buildRuntimePolicy`), so no IAM widening is needed — the broker
  can sign URLs under the assumed app role exactly as it does for
  shared data today.
- Multipart-upload support for files >5 GB comes for free with the
  shared-data infrastructure already in place (`S3ObjectStorageAdapter`
  in `storage-s3` handles it).
- The `parseObjectKey` path-trust check in the broker
  (`api-handler.ts`) already rejects `apps/<other-app>/...` keys, so
  presign requests can reuse it.

## Source

From doc id 14 (`functional-doc-cloud-data-server-2026-06-05.md`),
Part 2 — Potential gaps (originally framed narrowly as "the 20 MB
cap exceeds APIGW's 10 MB body limit"). Reframed during processing on
2026-06-11 after recognizing this is a missing-feature, not a
misleading constant.

## Revisit when

Top priority — should be the next foundational data-plane fix after
the 2026-06-10 HMAC pass settles. Latest acceptable trigger: any app
needs to store an app-private file larger than ~10 MB.
