# E2E test: broker app-data file write → sync-down, in one process

The app-data file plane (presign → direct upload → register; existence via
the `_starkeep_sync_records` index; bidirectional blob sync) is now covered
by two complementary but *separate* test layers:

1. **Broker write path** — `cloud-data-server/__tests__/routes-db.test.ts`
   exercises the real `POST /app-data/files/presign`, the `/record`
   registration, and the index-based `GET` against the exported Lambda
   handler with DSQL faked and S3/STS mocked.
2. **Sync carriage** — `apps/local-data-server/__tests__/sync-over-wire.test.ts`
   ("app-specific files across the wire") proves an app-private file syncs
   local→cloud→local and cloud→local, with blob residency on the receiving
   side. The cloud-origin write is reproduced via `FakeCloud.setAppFile`,
   which writes the index row + bytes through the same
   `createAppSpecificFactory` the broker uses — **not** through the broker's
   HTTP presign/register handlers.

## The gap

No single test drives the **real broker HTTP handlers** to write an
app-private file (presign → S3 upload → register) and then **syncs it down
to a real local-data-server** in the same run. The fake cloud deliberately
mounts only `/sync/exchange` + blob endpoints, not the `/app-data/...`
broker routes, so the wire harness can't originate a write through the
broker's actual request path. We therefore trust that the broker's write
*effects* match `setAppFile` — which is true today but is an assumption a
refactor of either side could silently break.

## Fix shape

Add an e2e test (Tier-3-ish, or a Tier-2 in-process composition) that:

1. Stands up the real cloud-data-server handler over its real storage +
   DB (DSQL or a sqlite-backed stand-in wired to the actual handler, not
   the fake cloud), with an app whose manifest declares
   `appSpecificSyncable.files`.
2. Performs the **full broker HTTP flow**: `POST /app-data/files/presign`,
   PUT bytes to the returned URL, `POST /app-data/files/<key>/record`.
3. Points a real local-data-server's sync supervisor at that cloud and
   converges.
4. Asserts the local side resolves `GET /app-data/files/<key>` to the
   original bytes (index row + blob both arrived through the genuine
   broker→sync path).
5. Reverse direction: write the file on the local side through its presign
   flow, converge, and assert the broker's `GET .../<key>` (index-based
   existence + presigned GET) serves it from cloud storage.

The photos cover-image feature (`starkeep-apps/photos`,
`app/api/photos/cover/route.ts` + `CoverImageBanner`) is the production
client this protects; an e2e could alternatively drive that route rather
than raw broker calls.

## Source

Identified 2026-06-14 while implementing todos 24/25 (presign flow +
index-based existence). Cross-references
[[todo-app-data-files-presigned-flow-2026-06-11]] and
[[todo-app-data-files-existence-probe-2026-06-11]] (both now done).

## Revisit when

Before relying on the app-data file plane in production, or the first time
the broker's write path or the sync file-transfer pass is refactored — that
is exactly when the untested seam between them could regress unnoticed.
