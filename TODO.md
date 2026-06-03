# TODO

## Cross-device duplicate-file merge on sync

When the `(owner_id, original_filename, content_hash)` uniqueness constraint
lands, it covers single-device ingestion only. The cross-device case is
deferred:

If device A and device B independently ingest the same bytes under the same
filename before they sync, each mints its own `shared_records.id` locally.
At sync time the two rows collide on the new natural-key unique index but
not on `id`, so the storage adapter's `INSERT … ON CONFLICT(id) DO UPDATE`
(packages/storage-sqlite/src/adapter.ts:95) won't catch it — replication
will throw on the unique violation.

Resolving this needs:

- A deterministic merge rule (e.g. lowest `id` wins, or earliest
  `created_at`) so both devices converge on the same surviving record.
- Adapter `put()` reworked to upsert on the natural key, not just `id`, OR
  a pre-insert lookup-and-rewrite in the sync engine that maps the
  incoming id to the local survivor's id.
- Rewriting any `parent_id` references on the loser to point at the
  winner before deletion.

Out of scope for the initial duplicate-prevention work; revisit once
multi-device sync is being exercised against this constraint.

## Rethink and overhaul "owner" field on data records

The current "owner" field on data records is a legacy concept that we need to rethink from the ground up in terms of desired functionality.

## The photos app has multiple divergent paths for adding photos, consolidate.

## Stop reading env variables

Currently server.ts reads STARKEEP_OWNER_ID and STARKEEP_NODE_ID from env, we should not be reading anything from env.

Possibly we should move OWNER_ID to starkeep config. Not sure about NODE ID. But they shouldn't be in ENV.

## The photos app structure is messy and probably contains legacy leftovers.

this repo has two top-level Photos components:

  - photos/app.tsx (PhotosAppInner) — the one actually rendered by the Next.js app you're running. It has the "Add Photo" button, the Browser/Local Sharp radio chips, and
  uploads via addPhotoFromPath straight to the local-data-server's /data/records.
  - photos/src/photos-ui/photos-app.tsx (PhotosApp) — an alternative root that uses the UploadZone drop zone, an "Upload" toggle button, and a Google import panel. It
  uploads via the Next.js /api/photos route.

  app.tsx imports lower-level pieces (PhotoGrid, PhotoViewer, PhotoProvider, etc.) from @/photos-ui but not the PhotosApp component itself. I haven't traced where (or if)
  PhotosApp is actually mounted — it may be dead code, a leftover from an older entry point, or used by some other harness I haven't found.

## Review "add photo" mechanics

- Review the data uploading process. For example here is what the local photos app does:

 Current flow in photos/app/api/photos/route.ts:

  1. Client uploads bytes to the Next.js route.
  2. Route reads the file, hashes it (contentHash is computed there to derive the storage key for presigning).
  3. Route calls POST /files/presign to get an upload URL.
  4. Route PUTs the bytes to S3 / local storage.
  5. Route calls POST /data/records — the dedup check runs here.

- Allow content hashes to be calculated on the client, which also enables client-side dupe checks. 