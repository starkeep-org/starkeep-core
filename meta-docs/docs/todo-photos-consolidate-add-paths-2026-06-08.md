# Photos app: consolidate add-photo paths and delete the dead PhotosApp branch

The photos app has two parallel upload code paths. The mechanism they use has already converged (both do presign → S3 PUT → POST `/data/records` by content hash), so the original "divergent paths" framing is stale. What remains is a dead-code branch, an audit of which `/api/photos` handlers still have live callers, and a misleading comment.

## State today

**Live entry point.** `app/page.tsx` → `app.tsx::App` → `app.tsx::PhotosAppInner`.
- Calls `addPhotoFromPath` (`src/lib/data-server-client.ts:89`).
- Hashes bytes client-side via `crypto.subtle.digest` (line 100), presigns at `/files/presign`, S3-PUTs, then POSTs `/data/records` with `{contentHash, sizeBytes}`.
- Talks to the data server directly (local or remote per `resolveDataSource()`).

**Dead entry point.** `src/photos-ui/photos-app.tsx::PhotosApp` (and the second function-local `PhotosAppInner` inside that file, distinct from the one in `app.tsx`).
- Exported from `src/photos-ui/index.ts:2` but **no importer** anywhere in `app/` or `src/`.
- Uses `UploadZone` and `usePhotos().uploadPhoto`.
- `uploadPhoto` (`src/photos-ui/hooks/use-photos.ts:55`) is the only caller of POST `/api/photos`.

**Next.js route.** `app/api/photos/route.ts`:
- POST handler at line ~111 does the same presign + PUT + record-by-hash flow.
- GET handlers on `/api/photos`, `/api/photos/:id`, `/api/photos/:id/thumbnail`, `/api/photos/:id/file`, `/api/photos/captions/:id`, `/api/photos/style-graphic`, `/api/photos/crop` are still live (called from `photo-url-context.tsx`, `use-photos.ts` GETs, `photo-info-panel.tsx`, `use-style-graphic.ts`).

**Misleading comment.** `data-server-client.ts:99` calls `POST /api/photos` "the canonical flow" — if that handler turns out to be dead, the comment is upside-down. The canonical client-side flow is `addPhotoFromPath` itself.

## What to do

1. **Confirm no live caller** of `PhotosApp`, `UploadZone`, and `usePhotos().uploadPhoto`. The pieces of `usePhotos()` that are GET-side (list / show / crop / delete) likely *are* live — split or trim the hook rather than deleting it wholesale.
2. **Delete** `src/photos-ui/photos-app.tsx`, the unused exports from `src/photos-ui/index.ts`, `UploadZone` if unused elsewhere, and `uploadPhoto` from `use-photos.ts`.
3. **Per-handler audit** of `app/api/photos/route.ts`. If the POST handler has no remaining caller after step 2, delete it. Keep the live GET handlers.
4. **Fix the stale comment** in `src/lib/data-server-client.ts:99` — the canonical client flow is `addPhotoFromPath`, not POST `/api/photos`.

## Connections

- The client-side dedup pre-check (skip the S3 PUT when the server already has `contentHash=X`) is a separate enhancement and lives in its own todo ([[todo-photos-client-side-dedup-precheck]] — to register).
- Several other photos-app upload sites still use the inline `fileBase64` form; those are tracked separately in the transfer-state-machine cleanup (resize-handler, crop, style-graphic, etc.).
