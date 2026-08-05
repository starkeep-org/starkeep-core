import {
  compareHLC,
  type AnyRecord,
  type HLCClock,
  type RecordLabel,
} from "@starkeep/protocol-primitives";
import {
  mergeDigestBuckets,
  scopeDigestBuckets,
  DEFAULT_BUCKET_PREFIX_LENGTH,
  type DatabaseAdapter,
  type DigestBucket,
  type ObjectStorageAdapter,
} from "@starkeep/storage-adapter";
import type {
  SyncTransport,
  SyncExchangeRequest,
  SyncExchangeResponse,
  AppSyncableRowEntry,
  AppSyncableNamespaceStore,
  AppSyncableApplier,
  ScanCapableApplier,
  Watermarks,
} from "../types.js";
import { SHARED_DIGEST_SCOPE } from "../types.js";
import { advanceWatermark } from "../watermarks.js";
import {
  computeCeilings,
  cutRound,
  type RoundItem,
  type StreamTruncation,
} from "../round-cut.js";
import {
  DEFAULT_RESPONDER_MAX_ITEMS,
  DEFAULT_RESPONDER_MAX_BYTES,
} from "../exchange-request.js";

/** Mirror of `FILE_RECORDS_TABLE`; only that table's rows carry blobs. */
const FILE_RECORDS_TABLE = "_starkeep_sync_records";

/** One row eligible to ship back, tagged with which stream it came from. */
type OutboundRow =
  | { kind: "record"; record: AnyRecord }
  | { kind: "label"; label: RecordLabel }
  | { kind: "appRow"; entry: AppSyncableRowEntry };

/**
 * Blob bytes an app-syncable row will make the caller download, or 0.
 *
 * Charging the byte budget for rows that carry no blob would throttle a channel
 * of captions as if it were a channel of photos; not charging for the ones that
 * do would hand a handset an unbounded download.
 */
function appRowBytes(entry: AppSyncableRowEntry): number {
  if (entry.table !== FILE_RECORDS_TABLE || entry.op === "delete") return 0;
  const row = entry.row;
  if (!row) return 0;
  const key = row["object_storage_key"];
  if (typeof key !== "string" || key.length === 0) return 0;
  const size = row["size_bytes"];
  return typeof size === "number" ? size : Number(size) || 0;
}

export interface InProcessTransportOptions {
  readonly databaseAdapter: DatabaseAdapter;
  readonly clock: HLCClock;
  /**
   * When provided, the transport synthesizes app-syncable row entries on
   * exchange (by scanning updated_at per table) and applies incoming rows on
   * apply (LWW UPSERT).
   */
  readonly appSyncableSource?: {
    readonly namespaces: AppSyncableNamespaceStore;
    readonly applier: AppSyncableApplier;
  };
  /**
   * Object storage backing the records this transport serves. Used only as a
   * reference for the file-transfer pass elsewhere; the exchange protocol
   * itself does no blob inspection.
   */
  readonly objectStorage: ObjectStorageAdapter;
  /**
   * Channel split (responder side). When true (default), this transport
   * applies and scans shared records (the `shared.records` table). The
   * cloud-side Drive channel sets this true with no `appSyncableSource`; per-app
   * channels set it false and serve only that app's app-specific rows. Mirrors
   * `SyncEngineOptions.syncSharedRecords` on the requester side.
   */
  readonly syncSharedRecords?: boolean;
}

/**
 * `SyncTransport` that talks directly to an in-process database adapter.
 * Used for tests and for running a "cloud" side in the same Node process.
 *
 * Exchange semantics:
 *   - Apply incoming records via `put(snapshot)` with HLC LWW.
 *   - Scan local records the caller hasn't seen (per-nodeId watermark filter).
 *   - Return `responderWatermarks` = MAX(updated_at) per nodeId.
 *
 * Conflict resolution is pure HLC LWW — no rejected[], no OCC.
 */
export function createInProcessSyncTransport(
  options: InProcessTransportOptions,
): SyncTransport {
  const { databaseAdapter, clock, appSyncableSource, syncSharedRecords = true } = options;

  return {
    async exchange(request: SyncExchangeRequest): Promise<SyncExchangeResponse> {
      // 1. Apply incoming app-syncable rows per nodeId in HLC order, stopping
      //    a node's application on its first failure (including a missing
      //    namespace). Holdings must stay a contiguous per-node prefix:
      //    applying a later same-node item after an earlier one failed would
      //    lift that node's coverage watermark over the failed row, and the
      //    requester would never re-ship it. App rows go first because their
      //    failures are the only silent ones (shared-record put() throws fail
      //    the whole exchange); nodes halted here also skip their shared
      //    records below.
      const haltedNodes = new Set<string>();
      const inboundAppRowsByNode = new Map<string, AppSyncableRowEntry[]>();
      for (const entry of request.appSyncableRows ?? []) {
        const arr = inboundAppRowsByNode.get(entry.timestamp.nodeId) ?? [];
        arr.push(entry);
        inboundAppRowsByNode.set(entry.timestamp.nodeId, arr);
      }
      for (const entries of inboundAppRowsByNode.values()) {
        entries.sort((a, b) => compareHLC(a.timestamp, b.timestamp));
        for (const entry of entries) {
          if (!appSyncableSource || !appSyncableSource.namespaces.get(entry.appId)) {
            console.warn(
              `[sync] exchange skipped appSyncableRow for unknown app "${entry.appId}"; halting node ${entry.timestamp.nodeId} this round`,
            );
            haltedNodes.add(entry.timestamp.nodeId);
            break;
          }
          clock.receive(entry.timestamp);
          try {
            await appSyncableSource.applier.apply(entry);
          } catch (err) {
            console.warn(
              `[sync] exchange apply appSyncableRow failed (app=${entry.appId} table=${entry.table}): ${(err as Error).message}; halting node ${entry.timestamp.nodeId} this round`,
            );
            haltedNodes.add(entry.timestamp.nodeId);
            break;
          }
        }
      }

      // 2. Apply incoming records — pure put(snapshot). HLC LWW: skip if local
      //    copy is at-or-ahead of incoming. Only the Drive channel
      //    (syncSharedRecords=true) applies shared records. Records from
      //    nodes halted in step 1 are skipped to preserve the contiguous
      //    prefix (they re-ship next round).
      //
      //    ## This iterates the wire order and does not sort. That is load-bearing.
      //
      //    Step 1 sorts app rows per node by HLC before applying, because their
      //    failures are silent and the contiguous prefix has to be maintained by
      //    hand. Steps 2 and 2b deliberately do not, and the reason they are
      //    allowed not to is narrow: **a shared-record `put()` that throws
      //    aborts the whole exchange.** No response is produced, so no coverage
      //    watermark is ever reported over a partially-applied author, so
      //    holdings cannot end up as a non-contiguous prefix — the requester
      //    simply re-ships everything next round and LWW makes it idempotent.
      //
      //    The moment shared-record apply becomes non-fatal — caught and folded
      //    into `haltedNodes` the way app rows already are — the missing sort
      //    stops being harmless and becomes silent loss under a watermark that
      //    claims coverage: a later row applies, an earlier one does not, and
      //    the union-of-MAX below reports the author as fully covered. Anyone
      //    relaxing the throw has to sort here in the same commit.
      //
      //    (Records are also applied entirely before labels rather than merged
      //    per author in HLC order, unlike the requester's inbound loop. Same
      //    argument, same dependency: safe only while the halt rule is a throw.)
      if (syncSharedRecords) {
        for (const snapshot of request.records ?? []) {
          if (haltedNodes.has(snapshot.updatedAt.nodeId)) continue;
          const current = await databaseAdapter.get(snapshot.id);
          if (current && compareHLC(current.updatedAt, snapshot.updatedAt) >= 0) {
            continue;
          }
          clock.receive(snapshot.updatedAt);
          await databaseAdapter.put(snapshot);
        }
      } else if ((request.records?.length ?? 0) > 0) {
        // Per-app channel received shared records — a channel-split violation
        // on the requester side. Drop them (the channel-split guard) but warn
        // so the misbehaving peer is discoverable.
        console.warn(
          `[sync] in-process transport dropped ${request.records?.length ?? 0} shared record(s) on a per-app channel (syncSharedRecords=false)`,
        );
      }

      // 2b. Apply incoming labels — same HLC LWW, same halted-node rule, on
      //     the label row's own timestamp. Labels are shared data, so a
      //     per-app channel drops them exactly as it drops records.
      if (syncSharedRecords) {
        for (const incoming of request.labels ?? []) {
          if (haltedNodes.has(incoming.updatedAt.nodeId)) continue;
          const current = await databaseAdapter.getLabel(
            incoming.recordId,
            incoming.appId,
            incoming.key,
            incoming.value,
          );
          if (current && compareHLC(current.updatedAt, incoming.updatedAt) >= 0) {
            continue;
          }
          clock.receive(incoming.updatedAt);
          // Snapshot write: an inbound retraction must stay retracted.
          await databaseAdapter.putLabel(incoming);
        }
      } else if ((request.labels?.length ?? 0) > 0) {
        console.warn(
          `[sync] in-process transport dropped ${request.labels?.length ?? 0} record label(s) on a per-app channel (syncSharedRecords=false)`,
        );
      }

      // 3. Scan what the caller hasn't seen — records, then labels, then
      //    app-syncable rows — as **delta scans**: the caller's per-nodeId
      //    watermarks go into the query, which seeks the
      //    `(node_id, updated_at)` index once per author rather than reading
      //    the table and discarding the rest. Steady state, with nothing owed,
      //    issues no range query at all.
      //
      //    The three streams share one `limit` budget so no stream can starve
      //    another, and `hasMore` reports that something was left behind — the
      //    caller's cue to come back immediately rather than wait for a tick.
      const limit = request.limit ?? DEFAULT_RESPONDER_MAX_ITEMS;
      // The caller's byte budget bounds what we hand back, so an inbound round
      // costs the caller no more than an outbound one. An older caller that
      // omits it gets our default rather than an unbounded pull.
      const maxBytes = request.maxBytes ?? DEFAULT_RESPONDER_MAX_BYTES;

      // Assembled exactly the way the requester assembles its own shipment, via
      // the same module. It used to be a sequence of per-stream budgets —
      // records trimmed to bytes, then labels against whatever item budget was
      // left, then app rows — and that shape cannot express the invariant. A
      // byte trim leaves the item budget untouched, so the label scan ran on and
      // shipped labels whose HLCs sat *above* the records the trim had just
      // withheld. The caller applied both, advanced its watermark to the label,
      // and never saw those records again.
      const truncations: StreamTruncation[] = [];
      const candidates: RoundItem<OutboundRow>[] = [];
      let unreadableStream = false;

      // Per-app channels (syncSharedRecords=false) never scan or ship shared
      // records or labels.
      if (syncSharedRecords) {
        const page = await databaseAdapter.querySince(request.watermarks, limit);
        truncations.push(page.truncated);
        for (const record of page.rows) {
          candidates.push({
            value: { kind: "record", record },
            hlc: record.updatedAt,
            bytes: record.objectStorageKey && !record.deletedAt ? record.sizeBytes : 0,
          });
        }

        // Labels carry no blobs, so they spend no byte budget — only the item cap.
        const labelPage = await databaseAdapter.queryLabelsSince(request.watermarks, limit);
        truncations.push(labelPage.truncated);
        for (const label of labelPage.rows) {
          candidates.push({ value: { kind: "label", label }, hlc: label.updatedAt, bytes: 0 });
        }
      }

      // 4. App-syncable rows, same delta rule across the registered tables.
      //    Every table is scanned every round: a table skipped for want of
      //    budget is a stream that enumerated nothing, which pins every
      //    author's ceiling to "nothing safe" and empties the round.
      if (appSyncableSource) {
        const scanCapable = appSyncableSource.applier as ScanCapableApplier;
        if (typeof scanCapable.scanSince === "function") {
          for (const ns of appSyncableSource.namespaces.list()) {
            for (const tableInfo of ns.tables) {
              try {
                const page = await scanCapable.scanSince(
                  ns.appId,
                  tableInfo.name,
                  request.watermarks,
                  limit,
                );
                truncations.push(page.truncated);
                for (const entry of page.rows) {
                  candidates.push({
                    value: { kind: "appRow", entry },
                    hlc: entry.timestamp,
                    bytes: appRowBytes(entry),
                  });
                }
              } catch (err) {
                console.warn(
                  `[sync] in-process transport scanSince failed for ${ns.appId}.${tableInfo.name}: ${(err as Error).message}`,
                );
                unreadableStream = true;
              }
            }
          }
        }
      }

      const cut = unreadableStream
        ? { taken: [] as RoundItem<OutboundRow>[], hasMore: true }
        : cutRound(candidates, computeCeilings(truncations), { maxBytes, maxItems: limit });
      const hasMore = cut.hasMore;

      const records: AnyRecord[] = [];
      const labels: RecordLabel[] = [];
      const appSyncableRows: AppSyncableRowEntry[] = [];
      for (const item of cut.taken) {
        if (item.value.kind === "record") records.push(item.value.record);
        else if (item.value.kind === "label") labels.push(item.value.label);
        else appSyncableRows.push(item.value.entry);
      }

      // 5. Coverage watermarks over this channel's full post-apply state
      //    (see SyncExchangeResponse.responderWatermarks). Scoped to the
      //    channel's own data plane: shared records only on the Drive
      //    channel, only the registered namespaces' tables on per-app
      //    channels.
      //
      //    A failed per-scope query omits its nodes, and **says so** through
      //    `coverageComplete`. The omission on its own was correct about
      //    correctness and silent about volume: an absent author is a floor of
      //    `undefined` on the requester, whose next outbound scan therefore
      //    starts from the beginning of that author's history — and since the
      //    requester replaces rather than merges the map, nothing anywhere
      //    notices. `progressed` is true (re-shipping the library *is*
      //    progress), `sync()` reports `complete: true`, the supervisor resets
      //    its backoff, and the next tick does it again. The only evidence was a
      //    console warning on the responder, which in the deployment that
      //    matters is a Lambda.
      //
      //    Two different facts were being encoded in one absence:
      //      - "I hold nothing from node N."  True and important — it is what
      //        makes re-ship after peer-side loss work, and the requester's
      //        authoritative-replace rule exists to serve it.
      //      - "I could not read my own coverage for scope S."  Unknown. It must
      //        not lower anything.
      //    The response type gave no way to say the second, so it said the
      //    first. `coverageComplete: false` is that missing sentence.
      //
      //    Deliberately **not** failing the exchange instead. The coverage
      //    report being unreadable does not make the round useless: the inbound
      //    direction still works and this side still applied what it was sent.
      //    Refusing would convert a degraded report into a total sync outage for
      //    that app. Report the degradation; do not weaponize it.
      const responderWatermarks: Watermarks = {};
      const unreadableCoverage: string[] = [];
      if (syncSharedRecords) {
        // A union over BOTH tables on this channel. Missing the label half
        // would let the watermark overstate coverage — the requester would
        // stop re-shipping labels the responder never received.
        //
        // Caught, where it used to be bare. The identical fault threw out of the
        // exchange here and was swallowed four lines below, so one of the two
        // was wrong by inspection; now both report through the same field.
        try {
          for (const hlc of Object.values(await databaseAdapter.getNodeWatermarks())) {
            advanceWatermark(responderWatermarks, hlc);
          }
          for (const hlc of Object.values(await databaseAdapter.getLabelNodeWatermarks())) {
            advanceWatermark(responderWatermarks, hlc);
          }
        } catch (err) {
          console.warn(
            `[sync] in-process transport getNodeWatermarks failed for shared records: ${(err as Error).message}`,
          );
          unreadableCoverage.push(SHARED_DIGEST_SCOPE);
        }
      }
      if (appSyncableSource) {
        const scanCapable = appSyncableSource.applier as ScanCapableApplier;
        if (typeof scanCapable.getNodeWatermarks === "function") {
          for (const ns of appSyncableSource.namespaces.list()) {
            for (const tableInfo of ns.tables) {
              try {
                const tableWatermarks = await scanCapable.getNodeWatermarks(
                  ns.appId,
                  tableInfo.name,
                );
                for (const hlc of Object.values(tableWatermarks)) {
                  advanceWatermark(responderWatermarks, hlc);
                }
              } catch (err) {
                console.warn(
                  `[sync] in-process transport getNodeWatermarks failed for ${ns.appId}.${tableInfo.name}: ${(err as Error).message}`,
                );
                unreadableCoverage.push(`${ns.appId}.${tableInfo.name}`);
              }
            }
          }
        }
      }

      // The integrity check, only when asked: a GROUP BY over the whole index
      // is cheap but not per-round cheap, and it answers a question that only
      // changes when something has gone wrong.
      //
      // Scoped to this channel's data plane, exactly like the scans and the
      // coverage watermarks above. A per-app channel digesting shared records
      // would hand the caller counts over rows this channel never carries.
      const prefixLength = request.digestPrefixLength ?? DEFAULT_BUCKET_PREFIX_LENGTH;
      let digest: DigestBucket[] | undefined;
      let digestScopes: string[] | undefined;
      if (request.requestDigest) {
        const buckets: DigestBucket[] = [];
        const scopes: string[] = [];
        let complete = true;
        if (syncSharedRecords) {
          scopes.push(SHARED_DIGEST_SCOPE);
          try {
            buckets.push(
              ...scopeDigestBuckets(
                await databaseAdapter.bucketDigest(prefixLength),
                SHARED_DIGEST_SCOPE,
              ),
            );
          } catch (err) {
            console.warn(
              `[sync] in-process transport bucketDigest failed for shared records: ${(err as Error).message}`,
            );
            complete = false;
          }
        }
        if (appSyncableSource) {
          const scanCapable = appSyncableSource.applier as ScanCapableApplier;
          if (typeof scanCapable.bucketDigest === "function") {
            for (const ns of appSyncableSource.namespaces.list()) {
              for (const tableInfo of ns.tables) {
                const scope = `${ns.appId}.${tableInfo.name}`;
                scopes.push(scope);
                try {
                  buckets.push(
                    ...scopeDigestBuckets(
                      await scanCapable.bucketDigest(
                        ns.appId,
                        tableInfo.name,
                        prefixLength,
                      ),
                      scope,
                    ),
                  );
                } catch (err) {
                  console.warn(
                    `[sync] in-process transport bucketDigest failed for ${ns.appId}.${tableInfo.name}: ${(err as Error).message}`,
                  );
                  complete = false;
                }
              }
            }
          }
        }
        if (complete) {
          digest = mergeDigestBuckets(buckets);
          digestScopes = scopes.sort();
        }
        // Otherwise send no digest at all. A table we could not count is not a
        // table we hold nothing in, and a short digest is worse than none: the
        // requester would read the uncounted rows as rows the responder lost
        // and arm a repair over all of them. Omitting it takes the branch that
        // already exists for a peer that cannot answer — `supported: false`,
        // which reads as "not checked" rather than "checked and broken".
      }

      return {
        records,
        labels,
        appSyncableRows,
        responderWatermarks,
        hasMore,
        // Omitted when the report is whole, so the common response stays the
        // shape it was and an older requester is unaffected. A single boolean is
        // the honest granularity: the watermarks are a per-node union *across*
        // scopes, so a per-scope gap cannot be attributed to particular nodes —
        // if any scope failed, the whole map is a lower bound rather than the
        // truth. The scope names ride alongside for the requester to log,
        // because "which table" is the first thing anyone will ask.
        ...(unreadableCoverage.length > 0
          ? {
              coverageComplete: false,
              coverageDetail: `could not read coverage for: ${unreadableCoverage.join(", ")}`,
            }
          : {}),
        // Whose items we stopped applying. The watermark already tells the
        // requester to re-ship; this tells it the round did not land, which is
        // the difference between "backup complete" and "nothing got through".
        // Omitted when empty so the common response stays the shape it was.
        ...(haltedNodes.size > 0 ? { haltedAuthors: [...haltedNodes] } : {}),
        // Echo the width actually used *and* what was counted, so a requester
        // can refuse to compare rather than compare buckets that mean different
        // things — a different width, or a different set of tables summed into
        // them.
        ...(digest ? { digest, digestPrefixLength: prefixLength, digestScopes } : {}),
      };
    },
  };
}
