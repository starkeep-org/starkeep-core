# Client-side dedup pre-check before S3 PUT

Today both servers dedup by content hash, but only **after** the bytes have been PUT to S3 — `apps/local-data-server/server.ts:1093` and the cloud handler around `api-handler.ts:498` check for an existing live record on `POST /data/records` and return `{ record, deduped: true }` without storing again. The PUT has already happened by then; the bandwidth is spent.

Client-side hashing (the prerequisite from the original TODO bullet "allow content hashes to be calculated on the client") is implemented today in `addPhotoFromPath` (`apps/photos/src/lib/data-server-client.ts:100`, `crypto.subtle.digest`). The follow-up — using that hash to skip the upload entirely when the server already has it — is not.

## Cases the pre-check would short-circuit

- A user re-imports the same photo (export + re-import from a different source).
- A second device imports a file the cloud already has after a backup-restore or cross-device duplicate ingest (see [[todo-shared-data-sync-cross-device-duplicate-merge]]).
- An app re-creates a derived blob (thumbnail) that already exists under `(parentId, contentHash)`.

For thumbnails and small images the savings are negligible; for videos, RAW photos, and document scans they are large.

## Shape

Two reasonable implementations:

1. **Dedicated probe.** `GET /data/records?contentHash=<hex>[&fileName=<name>]` (or `HEAD /files/{key}`) returning the existing record on hit. Client: hash → probe → if hit, skip the presign+PUT, optionally still POST `/data/records` to register a parent_id link or just consume the returned record. If miss, fall through to the existing flow.
2. **Piggyback on `/files/presign`.** Have presign return `{ existing: true, record }` when the well-known content-addressed key is already populated, so the client skips the PUT it would otherwise perform with the issued URL.

Option 1 is cleaner: the probe is independent of presign and reusable from any caller (CLI tools, the resize handler, the watcher).

## Scope

- `apps/local-data-server/server.ts` — add the probe handler.
- `packages/admin-installer/builtin-apps/cloud-data-server/src/api-handler.ts` — same on the cloud side.
- `apps/photos/src/lib/data-server-client.ts::addPhotoFromPath` — pre-check before S3 PUT.
- `apps/photos/app/api/photos/route.ts` POST handler — same, if it survives the [[todo-photos-consolidate-add-paths]] cleanup; otherwise this site disappears.

## Connections

- [[todo-photos-consolidate-add-paths]] — closes out the other half of the original TODO bullet; this is the remaining enhancement.
- [[todo-shared-data-sync-cross-device-duplicate-merge]] — overlapping case (a probe would not by itself fix the cross-device merge, but it would reduce how often the natural-key collision happens, by catching the duplicate before the second-device record gets created).
