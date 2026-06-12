# TODO: Photos EXIF orientation is never extracted (exifr translates it to a string)

`extractExif` (`photos/src/photos-lib/metadata/exif-reader.ts`) reads
`parsed.Orientation` through `numberOrNull(...)`. But `exifr.parse()` with
default options *translates* tag values: Orientation comes back as a string
like `"Horizontal (normal)"`, never a number. `numberOrNull` therefore always
returns null — the `orientation` field is dead for every upload, on every
path, regardless of the camera.

Portrait photos shot on phones (orientation 6/8) will render rotated wherever
the consumer relies on the metadata row rather than the bytes' own EXIF.

Fix options: pass `{ translateValues: false }` (check it doesn't change the
other fields the reader uses — Make/Model/FNumber/ISO are untranslated today,
but DateTimeOriginal parsing may shift), request the orientation specifically
via `exifr.orientation(bytes)` (returns the numeric value), or map the
translated strings back to the 1–8 numbers.

Surfaced 2026-06-12 writing the Tier-0 suite for case 7b:
`photos/__tests__/exif.test.ts` pins `orientation === null` for a TIFF whose
IFD0 carries Orientation=1, with a comment to flip the assertion to
`.toBe(1)` when this is fixed.

Related finding: `todo-photos-ui-upload-skips-metadata-2026-06-12.md` (the UI
upload path skips metadata entirely, so today this bug only manifests via
`POST /api/photos`).
