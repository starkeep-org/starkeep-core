/**
 * The order in which a side applies what a peer shipped it: per author, in HLC
 * order, across records, labels and app-syncable rows together.
 *
 * Both ends of an exchange apply in this order, but they treat a failed row
 * differently. The requester carries on past it and holds its watermark for
 * that author at the failed row (`brokenAt` in `sync-engine.ts`); the
 * responder stops the author's run there and halts it for the round. On the
 * responder every write raises its author's coverage on the way, so the order
 * is what keeps that coverage honest. Applying all of an
 * author's records before any of its labels lifts coverage over a label whose
 * HLC sits below one of the records, and a crash or a concurrent reader in that
 * window loses the label for good (`specs/exchange-round`, finding 1).
 *
 * Items that share an HLC keep the order they arrived in: records, then
 * labels, then app rows. Nothing here makes one HLC atomic, which is the
 * separate concern of finding 2.
 */

import { compareHLC, type HLCTimestamp, type RecordLabel } from "@starkeep/protocol-primitives";
import type { AppSyncableRowEntry, SyncRecordItem } from "./types.js";

export type InboundItem =
  | { kind: "record"; record: SyncRecordItem }
  | { kind: "label"; label: RecordLabel }
  | { kind: "appRow"; entry: AppSyncableRowEntry };

export function inboundItemHlc(item: InboundItem): HLCTimestamp {
  if (item.kind === "record") return item.record.updatedAt;
  if (item.kind === "label") return item.label.updatedAt;
  return item.entry.timestamp;
}

/** Each author's inbound items, merged across the three streams and sorted by HLC. */
export function groupInboundByNodeId(
  records: readonly SyncRecordItem[],
  labels: readonly RecordLabel[],
  appRows: readonly AppSyncableRowEntry[],
): Map<string, InboundItem[]> {
  const out = new Map<string, InboundItem[]>();
  const push = (nodeId: string, item: InboundItem): void => {
    const arr = out.get(nodeId) ?? [];
    arr.push(item);
    out.set(nodeId, arr);
  };
  for (const r of records) push(r.updatedAt.nodeId, { kind: "record", record: r });
  for (const l of labels) push(l.updatedAt.nodeId, { kind: "label", label: l });
  for (const e of appRows) push(e.timestamp.nodeId, { kind: "appRow", entry: e });
  for (const arr of out.values()) {
    arr.sort((a, b) => compareHLC(inboundItemHlc(a), inboundItemHlc(b)));
  }
  return out;
}
