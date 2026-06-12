# TODO: Photos UI upload path never writes image metadata (EXIF/dimensions)

The photos manifest requests `metadataWrite: true` with the rationale "writes
EXIF/dimensions extracted from uploaded image files into the image metadata
table", and the platform test plan (doc 43, §7b) expects "EXIF/dimensions land
in image metadata" as a core app-functionality flow. The live UI never does
this.

Photos has two parallel upload implementations:

- `POST /api/photos` (`app/api/photos/route.ts`) — server-side: extracts EXIF
  via exifr, dimensions via sharp, uploads via presign, registers the record,
  and writes the metadata row. Complete, but **unused by the page actually
  served**: it is called only by `src/photos-ui/` (`use-photos.ts`), a UI tree
  that `app/page.tsx` does not mount.
- `app.tsx` (the mounted UI) → `addPhotoFromPath` in
  `src/lib/data-server-client.ts` — browser-side: presign + register through
  the generic `/api/local-data/[...path]` proxy. **No metadata write at all**;
  EXIF extraction never runs on this path.

Net effect: photos uploaded through the UI have no width/height/EXIF in the
shared image metadata table, locally or after sync. The thumbnail resize route
does write width/height for the thumbnails it creates, which masks the gap in
the grid.

Decide which path is canonical: either route the UI's upload through
`POST /api/photos` (server-side extraction, one fewer implementation), or move
extraction client-side into `addPhotoFromPath` and write metadata through the
proxy. Also reconcile or delete the unmounted `src/photos-ui/` tree — it is a
trap for readers (and for tests; it cost this session a debugging round).

Surfaced 2026-06-12 implementing case 7b: the e2e spec
`photos/e2e/photos-app.spec.ts` ("an uploaded photo appears in the grid as a
shared record") pins `metadata === null` for a UI upload, and covers the
extraction behavior against `POST /api/photos` directly. When this is fixed,
flip the pinned assertion to expect width/height and merge the two coverage
paths.

Related findings:
- `todo-photos-consolidate-add-paths-2026-06-08.md` (doc 30) — the
  consolidation/dead-branch cleanup this gap is a consequence of; fixing that
  one properly resolves this one.
- `todo-photos-exif-orientation-never-extracted-2026-06-12.md` (doc 48) —
  orientation is dropped even on the working path.
