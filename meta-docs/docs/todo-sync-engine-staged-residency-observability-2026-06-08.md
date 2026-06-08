# Observability for records stuck in `staged` residency

There is currently no structured visibility into records whose blob hasn't been observed on a given side. The sync engine emits `console.warn` only on error paths (`packages/sync-engine/src/sync-engine.ts:150,264,339,531`, `transports/in-process-transport.ts:81,95,165`) — nothing on residency transitions, no counters for `staged` records.

In the new residency model (`packages/sync-engine/src/residency.ts` and `system-design.md` "Per-record residency"), the symptom of "stuck file transfer" is a record in `staged` residency past its `updated_at`: the row is present but the blob is not. The watermark-gap principle says the next `exchange()` round naturally surfaces the gap and re-checks `storage.has(key)`, so things eventually unstick — but today there is no signal that the gap exists, how big it is, or how old.

## Read this first

**The primary fix for stuck `staged` records is [[todo-cloud-data-server-upload-confirmation]] — that todo is strictly more important than this one.** That work eliminates the dominant cause of the symptom: a client's presigned PUT completes but the cloud's `storage.has(key)` only runs on the next exchange round, leaving the cloud's watermark stuck below the record's `updated_at` in the meantime. With an explicit confirm endpoint (or S3 event notification), the cloud learns about blob arrival promptly and residency flips `staged` → `resident` without waiting for an exchange round.

Do **not** treat this telemetry as a substitute for that fix. The telemetry exists to catch what leaks through after the cause is addressed — partial uploads, retries, cross-device gaps, dropped S3 events — not to mask the latency `[[todo-cloud-data-server-upload-confirmation]]` is meant to remove.

## What to add

1. **Structured log on residency transitions during `exchange()`.** Each time `residencyOf()` flips `staged` → `resident`, emit a line with `(record_id, side, age_from_updated_at)`. Emit a per-round summary when an exchange round completes with N records still in `staged` on this side.
2. **`staged`-residency counters on both sides**, exposed via the existing health/status surface — local-data-server's `/sync/status`, cloud's per-app `/health`. Derivable cheaply by scanning rows whose `updated_at > watermark[ownNodeId]` (or HEAD-sample for a precise blob-presence count); choose at implementation time.

## What's stale in the original TODO framing

- `PendingFileDownload` (the column-backed state) → `staged` (derived residency).
- "structured log lines on state transitions" → there are no explicit transitions in the new model; the equivalent is logging when `residencyOf()` flips during `exchange()`.
- "non-terminal states" → just `staged`; `absent`, `resident`, `tombstoned` are all terminal for telemetry purposes.

## Connections

- [[todo-cloud-data-server-upload-confirmation]] — fixes the major cause of stuck `staged`. Strictly higher priority than this. Land that first; revisit this after to see what stuck records remain.
