# File Browser

The file browser is a lightweight read-only UI for inspecting records stored in the data-server. It's a debugging and exploration tool — useful for verifying that records were indexed correctly and for inspecting their raw metadata.

## Running

Requires the data-server to be running first.

```bash
pnpm --filter @starkeep/file-browser dev
```

Opens on port 5173 (Vite default).

## What It Does

The file browser has a two-panel layout:

- **Left panel** — A table of all records, showing Object ID, filename, path, type, and date added. The total record count is displayed at the top.
- **Right panel** — When you select a record, the full metadata payload is displayed as JSON. This includes everything the metadata generators have produced for that record.

The file browser fetches all records and their metadata from the data-server on load and updates when you select different records. It does not support creating, editing, or deleting records.

## Use Cases

- Verify that a file watch indexed a directory correctly
- Inspect the raw metadata produced by generators (e.g., check EXIF fields extracted from a photo)
- Confirm record types and payloads look as expected after uploading or syncing
