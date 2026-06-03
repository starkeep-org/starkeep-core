import { ZERO_HLC, compareHLC, maxHLC, type HLCTimestamp } from "@starkeep/protocol-primitives";
import type { AnyRecord } from "@starkeep/protocol-primitives";
import type { Watermarks, AppSyncableRowEntry } from "./types.js";

/**
 * Compute the responder's watermarks across a set of records — the
 * `MAX(updated_at)` per nodeId. Caller advertises these on the next exchange
 * round so the responder ships only records the caller hasn't seen yet.
 */
export function computeRecordWatermarks(records: Iterable<AnyRecord>): Watermarks {
  const out: Watermarks = {};
  for (const r of records) {
    advanceWatermark(out, r.updatedAt);
  }
  return out;
}

export function computeAppSyncableWatermarks(
  rows: Iterable<AppSyncableRowEntry>,
): Watermarks {
  const out: Watermarks = {};
  for (const r of rows) {
    advanceWatermark(out, r.timestamp);
  }
  return out;
}

/** Advance `watermarks[hlc.nodeId]` to `max(current, hlc)`. */
export function advanceWatermark(watermarks: Watermarks, hlc: HLCTimestamp): void {
  const node = hlc.nodeId;
  const existing = watermarks[node];
  if (!existing || compareHLC(hlc, existing) > 0) {
    watermarks[node] = hlc;
  }
}

/** Merge `incoming` into `into`, taking the max per nodeId. */
export function mergeWatermarks(into: Watermarks, incoming: Watermarks): Watermarks {
  const out: Watermarks = { ...into };
  for (const [node, hlc] of Object.entries(incoming)) {
    const existing = out[node];
    out[node] = existing ? maxHLC(existing, hlc) : hlc;
  }
  return out;
}

/** Watermark for `nodeId`, or `ZERO_HLC` if unseen. */
export function watermarkFor(watermarks: Watermarks, nodeId: string): HLCTimestamp {
  return watermarks[nodeId] ?? ZERO_HLC;
}

/**
 * Return records the peer hasn't seen yet, judged against `peerWatermarks`:
 * `record.updatedAt > peerWatermarks[record.updatedAt.nodeId] ?? ZERO_HLC`.
 */
export function selectUnseen<T extends { updatedAt: HLCTimestamp }>(
  records: T[],
  peerWatermarks: Watermarks,
): T[] {
  return records.filter(
    (r) => compareHLC(r.updatedAt, watermarkFor(peerWatermarks, r.updatedAt.nodeId)) > 0,
  );
}

export function selectUnseenAppSyncable(
  rows: AppSyncableRowEntry[],
  peerWatermarks: Watermarks,
): AppSyncableRowEntry[] {
  return rows.filter(
    (r) => compareHLC(r.timestamp, watermarkFor(peerWatermarks, r.timestamp.nodeId)) > 0,
  );
}
