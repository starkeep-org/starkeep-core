# Use a HEAD probe for `/app-data/files/<key>` existence

The cloud broker's `GET /apps/{appId}/app-data/files/<key>` handler in
`packages/admin-installer/builtin-apps/cloud-data-server/src/api-handler.ts`
currently calls `view.getFile(subKey)` purely to return 404 when the
object is absent, then `storage.getSignedUrl` to issue the redirect.
Depending on whether the `shared-space-api` factory implements
`getFile` via a HEAD or a full GET, the Lambda may be downloading the
entire object into memory before returning a presigned URL the caller
will use to fetch the same bytes from S3 directly.

## Fix shape

Add a HEAD-style probe in `@starkeep/shared-space-api` —
`view.hasFile(subKey)` returning `boolean`, or expose a
`storage.head(key)` that returns metadata without bytes — and use it
for the existence check. Keep `getFile` for callers that actually want
the bytes.

## Source

From doc id 14 (`functional-doc-cloud-data-server-2026-06-05.md`),
Part 2 — Potential gaps. Deferred by
`plan-cloud-auth-foundational-fixes-2026-06-11.md`.

## Revisit when

Thumbnail / caption load latency on the cloud-served photos app becomes
a complaint, or the first time a large-file app-private store ships
(at which point the wasted bandwidth becomes visible in the bill).
