# Check `/app-data/files/<key>` existence via the index, not S3

The cloud broker's `GET /apps/{appId}/app-data/files/<key>` handler in
`packages/admin-installer/builtin-apps/cloud-data-server/src/api-handler.ts`
currently calls `view.getFile(subKey)` purely to return 404 when the
object is absent, then `storage.getSignedUrl` to issue the redirect.
`view.getFile` (`shared-space-api/src/app-syncable/factory.ts`) calls
`fileStorage.get(key)`, which **downloads the entire object into the
Lambda's memory** — only to throw the bytes away after the `if (!file)`
check. The caller then fetches the same bytes again, directly from S3,
via the presigned URL. The local-data-server's GET has the same shape
through `view.fileUrl`, which also `fileStorage.get`s before presigning.

## Fix shape (revised 2026-06-14)

The original framing proposed a HEAD probe against S3. That's better than
a full GET, but it still hits S3 to answer a question the system already
has an authoritative answer for.

Every `putFile` writes a row into the reserved `_starkeep_sync_records`
table (`upsertFileRecord` in `factory.ts`) carrying `object_storage_key`,
`content_hash`, `mime_type`, `size_bytes`, and a `deleted_at` tombstone
column; `deleteFile` tombstones it. That row **is** the file's index — it
is what syncs across channels and tells the rest of the system the file
exists. It already lives in the cloud DB (todo 23 populates the cloud
tables). So existence — plus mime type and size for free — is answerable
from the DB with **zero** S3 calls.

Add a `statFile(subKey)` method to `AppSpecificOperations`:

- Returns `{ mimeType, sizeBytes, contentHash } | null` by querying
  `_starkeep_sync_records` for the row whose `id` (= the object storage
  key) matches, with `deleted_at IS NULL`. The applier's `queryRows`
  already filters soft-deleted rows; the new method must bypass the
  factory's `resolveTable` guard (which rejects the reserved table for
  app callers) and read it directly.
- Existence checks in the broker GET and the local GET use `statFile`;
  `getFile` stays for callers that genuinely want bytes.

Answering existence from the index is also the more *correct* contract:
a file counts as present exactly when its index row is live, regardless
of stray bytes left by a torn write.

## Coupling with todo 24

Todo 24 moves uploads to direct-to-S3 presign, which bypasses `putFile`
and therefore the index-row write. So todo 24 must add an explicit
`registerFile` step that writes the same index row after a presigned
upload — otherwise presigned files would be invisible to this existence
check (and to cross-channel sync). The two todos are implemented together.

## Source

From doc id 14 (`functional-doc-cloud-data-server-2026-06-05.md`),
Part 2 — Potential gaps. Deferred by
`plan-cloud-auth-foundational-fixes-2026-06-11.md`. Reframed 2026-06-14
from "HEAD probe" to "use the index" after recognizing the
`_starkeep_sync_records` row is the authoritative existence signal.

## Revisit when

Implemented alongside todo 24.
