# Photos

Photos is a photo management app built on Starkeep. It demonstrates the thin-client pattern: the Next.js server talks to the data-server over HTTP rather than embedding the SDK directly.

## Running

Requires the data-server to be running first.

```bash
pnpm --filter photos-web dev
```

Opens on port 3000. Run only one of photos-web or admin-web at a time (they share the same port).

## What It Does

- **Browse photos** — Gallery view of all photos stored in Starkeep, with metadata displayed alongside each image
- **Upload photos** — Add new photos via the web interface; files are stored through the data-server and synced to cloud if configured
- **View metadata** — Image dimensions, EXIF data (camera model, capture date, GPS coordinates if present), file size, and MIME type are extracted automatically and displayed per photo

## Architecture

Photos-web is a thin client. The Next.js server makes authenticated requests to the data-server (running on port 9820 locally) for all data operations — listing records, fetching files, and uploading new photos. The data-server applies access control and returns results.

This means the SDK, type registry, and storage all live in the data-server process, not in photos-web. Photos-web is purely a presentation layer.

EXIF metadata is extracted by a generator registered on the data-server. When a photo is uploaded, the generator runs automatically and the metadata is available for display and search.
