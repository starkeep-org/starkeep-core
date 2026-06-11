# Rationalize and disambiguate file extension vs MIME type across the system

Today the system carries several overlapping notions of "what kind of file is this", with no single doc that pins down which one is authoritative for which purpose:

- **Record `type`** — used in the shared-data type-categories model as the file extension (e.g. `jpg`, `png`, `md`). Validated against an app's grants on write; carried in object keys and dedup.
- **`mimeType` / `mime_type`** — on the file record in shared-space-api (`reserved.ts` declares the `mime_type` column; `factory.ts` reads/writes it), surfaced in `getFile`/`putFile` and on the `app-syncable` factory.
- **`contentType`** — used by the sync-engine HTTP transport (`http-server.ts`) and by file-storage put/get; sometimes derived from request headers, sometimes from the manifest's `mimeType`, with `application/octet-stream` fallbacks scattered around.
- **Filename extension** extracted client-side (`starkeep-apps/photos/src/lib/file-extension.ts`) — already carries an in-code `TODO: Fully reconcile mime type with file extension and determine file types properly. After which this file should be removed.`

These aren't synonyms:

- Extension is a short, app-grantable, dedup/key-affecting label that says "what category of file the app is claiming to write." It's part of the shared-data trust boundary (grants are by category/extension).
- MIME type is what HTTP needs to serve the bytes correctly to a browser, and what apps want when reading. It's a property of the bytes, not the grant surface.
- `contentType` on transport is really just MIME — the naming difference is incidental.

Concretely, decide:

- **Single source of truth per concern.** Which field is canonical for grants/keying (extension), which for serving (MIME), and the rule for derivation/validation between them on write.
- **Where the mapping lives.** Centralize ext↔mime in one place (probably `@starkeep/protocol-primitives` or the shared-data type-categories module) instead of ad-hoc `application/octet-stream` fallbacks.
- **Naming.** Pick one of `mimeType` / `contentType` for the in-process API surface and migrate the other; keep `mime_type` only as the column name.
- **Validation on write.** Today the data-server validates the record `type` (extension) against grants. Should it also validate that the supplied MIME is consistent with that extension, or is MIME purely advisory metadata?
- **Client extraction.** Once the model is settled, delete `starkeep-apps/photos/src/lib/file-extension.ts` per its in-file TODO, replacing callers with the centralized helper.

Touches: shared-data type-categories and type-metadata, shared-space-api file API, sync-engine file transport, and the photos app client lib. Not user-visible; pure cleanup / type-safety / trust-boundary clarity. Revisit when next touching the file-record schema or grant-validation logic; no external trigger.
