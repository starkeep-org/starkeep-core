# Runbook: read a device's sync session from the cloud logs

The cloud data server writes two structured lines that, read together, tell what a phone or a desktop did:

- `sync-exchange`: one line per exchange. It records the rows in each direction and the walk over the cloud's bytes watermark. The walk part shows where the watermark started and ended, and the first missing file per author.
- `upload-batch`: one line per uploader request. It records how the cloud answered each file and the uploader's own report since its previous request.

Both lines carry `caller`. A signed-in device appears as `caller.device`, the user id. An app's Lambda appears as `caller.app`.

## Problems this runbook addresses

1. A phone's release build writes no logs that `adb logcat` can read, so the device itself cannot say what it did.
2. Rows and files move separately. The exchange line alone cannot say whether an upload failed, was skipped, or never started.
3. A session cut short by the operating system leaves no line of its own. Its absence has to be read from the next session's first batch.

## Where the lines are

- Log group: `/aws/lambda/starkeep-app-cloud-data-server-api`, in the deployment's region.
- Both line kinds are JSON in `@message`. Logs Insights flattens nested fields with dots, such as `answered.signed` and `report.failureCount`.

## The timeline query

The query prints one device's session in time order. Replace `USER_ID` with the user's id, the `sub` of the device's token. Choose the time range in the console, or pass it to the CLI below.

```
fields @timestamp, event, appId,
  in.records as rowsIn, out.records as rowsOut, hasMore,
  answered.present as present, answered.signed as signed, answered.refused as refused,
  answered.error as itemErrors, answered.absent as inParts, bytesSigned,
  report.succeeded.fast.count as fastSent, report.succeeded.full.count as fullSent,
  report.failureCount as failures, report.blockedNotHeld as blocked,
  report.queue.fast as queuedFast, report.queue.full as queuedFull,
  report.state as uploaderState, report.sinceMs as sinceMs,
  durationMs
| filter caller.device = "USER_ID" and event in ["sync-exchange", "upload-batch"]
| sort @timestamp asc
| limit 2000
```

## The detail query

The timeline leaves out two nested parts whose field names vary: the walk's per-author pins on `sync-exchange`, and the uploader's failures and unfinished batches on `upload-batch`. This query prints whole lines that carry either part.

```
fields @timestamp, event, @message
| filter caller.device = "USER_ID"
| filter (event = "sync-exchange" and @message like /"pins":\{"/)
      or (event = "upload-batch" and (report.failureCount > 0 or @message like /unfinishedBatches/))
| sort @timestamp asc
| limit 500
```

## Running a query from the CLI

```
aws logs start-query \
  --log-group-name /aws/lambda/starkeep-app-cloud-data-server-api \
  --start-time $(date -u -v-6H +%s) --end-time $(date -u +%s) \
  --query-string "$(cat timeline.query)"
aws logs get-query-results --query-id <id from the first command>
```

On Linux, replace `date -u -v-6H +%s` with `date -u -d '6 hours ago' +%s`.

## Reading the result

- **Uploads flowing.** `upload-batch` lines arrive every few seconds while the app is open. `fastSent` rises before `fullSent`, because stand-ins go before originals.
- **Uploads stopped by the network.** `uploaderState` reads `paused`, and the next report's `failures` name network errors.
- **A session cut short.** The first `upload-batch` of the next session carries `unfinishedBatches`. Each entry names a batch whose transfers never settled, because the operating system froze or killed the app. The detail query shows them.
- **A file pinning the watermark.** On `sync-exchange`, `bytes.pins` names the first missing file per author. The same short key appearing across many exchanges is a pin. If no `upload-batch` line reports that file as sent or failed, the device does not hold the file or never queued it.
- **A file refused.** `refused` counts files the cloud declined as no-cloud. The uploader drops them from its queue.
- **No `upload-batch` lines at all.** The uploader did not run. The phone starts it only in the foreground on an unmetered network, and in background windows.

## Related

- `~/projects/starkeep/design-upload-queue-2026-10-23.md`, section "Logging"
- `packages/sync-engine/src/uploader.ts`, `UploadBatchReport`
- `packages/admin-installer/builtin-apps/cloud-data-server/src/api-handler.ts`, the `upload-batch` and `sync-exchange` lines
