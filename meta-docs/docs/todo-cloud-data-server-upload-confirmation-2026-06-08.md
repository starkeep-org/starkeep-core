# Server-side upload-completion signal for presigned PUTs

The cloud-data-server has no direct signal when a client's presigned-PUT upload to S3 completes. Today the chain is:

1. Client POSTs `/data/records` → cloud row written with HLC `T`.
2. Client PUTs bytes to S3 directly via presigned URL — **cloud sees nothing**.
3. Cloud's residency for that record stays `staged` (in the [[residency]] sense: row present, blob absent) until something runs `storage.has(key)`.
4. Per the watermark-gap principle in `system-design.md` ("Per-record residency"), the next `exchange()` round naturally re-checks `storage.has(key)`, eventually flips residency to `resident`, and lets the cloud's watermark advance.

The safety net works. The cost is **latency** between the PUT completing and the cloud learning about it: until an exchange round runs, the cloud's watermark for that record stays stuck below `updated_at`. Downstream clients can pull the row, but a presigned GET against S3 may 404 in that window.

## Options

- **Explicit confirm endpoint.** `HttpObjectStorageAdapter.put`, on a 2xx from S3, calls `POST /apps/{appId}/files/{key}/confirm`. Server verifies blob presence via `storage.has(key)`; the success result is that the cloud's residency for the corresponding record flips `staged` → `resident` and the watermark advances. Lazy `storage.has` in `exchange()` remains the safety net.
- **S3 event notifications → Lambda.** Same outcome via S3 → Lambda → residency recheck. More AWS plumbing, no client-side change.

The lazy recheck in `exchange()` stays as the safety net either way.

## What's stale in the original TODO

The TODO was written against the prior sync model and needs the following substitutions:

- `PendingFileDownload` (state name) → `staged` (derived residency, per `packages/sync-engine/src/residency.ts`).
- "Flips matching `PendingFileDownload` records to `Synced`" → "advance residency `staged` → `resident` and let the watermark advance past `updated_at`". There is no `sync_status` column to write.
- `packages/sync-engine/src/transports/in-process-transport.ts::pullChanges` → `exchange()` in the same file (the transport now exposes a single `/sync/exchange` round, not separate pull/push).
- "the server's record stays in `PendingFileDownload` indefinitely" → "the cloud's watermark stays stuck below the record's `updated_at` until an exchange round triggers the lazy `storage.has` check".

## Connections

- The residency model is the load-bearing context: `packages/sync-engine/src/residency.ts` and the "Per-record residency" section of `system-design.md`.
- The `objectStorage` optional-cleanup (originally bundled in this TODO as Q4) is already resolved: `InProcessTransportOptions.objectStorage` is now required (`packages/sync-engine/src/transports/in-process-transport.ts:36`).
