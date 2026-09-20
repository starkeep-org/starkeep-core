/**
 * This node's answers to the four questions an app asks about its own bytes.
 *
 * The app-private plane stopped being the platform's to manage. An app
 * namespace carries one advisory ceiling, the eviction pass skips it, and a
 * sync round applies the app's rows without pulling its blobs — so an app that
 * wants bytes here has to ask for them, and an app that wants disk back has to
 * give them up itself. This is the surface it does both through.
 *
 * Everything below is node-local. Nothing here writes a row anything will sync,
 * and that is the property that makes a drop safe to run on one machine: the
 * file survives everywhere, including here, and only the bytes go.
 *
 * ## Why the durability check lives on the drop rather than on a pass
 *
 * The eviction pass used to be the thing standing between a budget and a last
 * copy, and it no longer runs over app namespaces. The refusal moved with the
 * decision: `dropAppBlob` applies the same durability rule the pass would have,
 * reading the app's `regenerable` declaration to decide whether proof is
 * needed. An app that says its blobs can be made again may drop its last copy;
 * an app that says nothing may not.
 */

import type {
  AppBlobDropResult,
  AppBlobFetchResult,
  AppBlobIdentity,
  AppBlobPlane,
  AppBlobResidencyPage,
} from "@starkeep/shared-space-api";
import type {
  BlobCandidate,
  FileSyncManifest,
  ReplicaProbe,
  ResidencyManager,
  SyncEngine,
} from "@starkeep/sync-engine";
import type { ObjectStorageAdapter } from "@starkeep/storage-adapter";

export interface AppBlobPlaneOptions {
  /**
   * Null on a node with no retention policy, which is the ordinary laptop:
   * every blob is wanted, nothing is evicted, and nothing is accounted.
   */
  readonly residency: ResidencyManager | null;
  /**
   * The cloud's storage *as this app sees it* — the app's own sync channel,
   * signed with the app's identity.
   *
   * The only peer a desktop can interrogate today, and therefore the whole of
   * the durability evidence behind a refusal. Per-app rather than one adapter
   * for the node because an app-private key is readable by exactly one
   * identity: the node's S3 adapter carries the human operator's credentials,
   * the files bucket denies every principal without a matching
   * `starkeep:appId` tag on `apps/*`, and a denial arrives as `null` from
   * `stat` — indistinguishable from bytes that are not there. Asking as the
   * operator therefore produced a permanent, unexplainable refusal for every
   * non-regenerable app.
   *
   * Resolved at call time for the same reason `engineFor` is: an app's channel
   * starts and stops with the app.
   */
  readonly remoteStorageFor: (appId: string) => ObjectStorageAdapter | null;
  /**
   * Resolved at call time rather than captured, because the supervisor is built
   * after the app-specific factory and an app's engine starts and stops with
   * the app.
   */
  readonly engineFor: (appId: string) => SyncEngine | null;
}

/** The cloud, as a probe. Named for reporting; there is only ever one of it. */
const CLOUD_NODE_ID = "cloud";

export function createAppBlobPlane(options: AppBlobPlaneOptions): AppBlobPlane {
  const { residency, remoteStorageFor, engineFor } = options;

  /**
   * Who this node can ask about a key.
   *
   * Empty when no cloud is configured, and that is the correct answer rather
   * than a missing one: `assessDurability` requires at least one confirmed
   * replica, so a node with nowhere to check refuses every drop of a
   * non-regenerable blob. A node that cannot see a second copy does not have
   * evidence that one exists.
   */
  function probes(appId: string): ReplicaProbe[] {
    const storage = remoteStorageFor(appId);
    return storage === null ? [] : [{ nodeId: CLOUD_NODE_ID, storage }];
  }

  /**
   * The app-syncable shape of a blob, for the residency decision.
   *
   * `appId` is what puts it in the app's namespace and charges it to the app's
   * one line; `parentId` and `type` are null because the platform knows nothing
   * about what an app-private blob is. Same shape the sync engine builds for an
   * app row arriving in a round, so the decision a fetch gets is the decision a
   * round would have got with a different trigger.
   */
  function candidateFor(
    appId: string,
    blob: AppBlobIdentity,
    lastOpenedAtMs: number | null,
  ): BlobCandidate {
    return {
      recordId: blob.objectStorageKey,
      objectStorageKey: blob.objectStorageKey,
      sizeBytes: blob.sizeBytes,
      type: null,
      parentId: null,
      appId,
      originAppId: appId,
      recencyAtMs: null,
      lastOpenedAtMs,
    };
  }

  function manifestFor(blob: AppBlobIdentity): FileSyncManifest {
    return {
      fileHash: blob.contentHash.length > 0 ? blob.contentHash : blob.objectStorageKey,
      objectStorageKey: blob.objectStorageKey,
      sizeBytes: blob.sizeBytes,
      mimeType: blob.mimeType,
    };
  }

  return {
    async residency(appId: string, cursor: string | null): Promise<AppBlobResidencyPage | null> {
      // No policy means no ceiling, no eviction, and a round that pulls every
      // blob it is offered — so this node holds what it has rows for, which is
      // the answer the file index already gives. Declining rather than
      // reporting an empty plane: an app reading "nothing of mine is here" for
      // every file it owns would re-derive its whole library on every pass.
      if (residency === null) return null;
      return residency.appBlobResidency(appId, cursor);
    },

    async lookup(appId: string, objectStorageKeys: readonly string[]) {
      // Declined for the reason `residency` above declines: no resident set
      // means the file index is the truth, and the caller reads it.
      if (residency === null) return null;
      return residency.appBlobResidencyOf(appId, objectStorageKeys);
    },

    async noteWritten(appId: string, blob: AppBlobIdentity): Promise<void> {
      if (residency === null) return;
      // Never-opened, which is the honest reading of "just written" and the
      // ordering an app wants: a rendition nobody has looked at is the first
      // thing worth giving up.
      const candidate = candidateFor(appId, blob, null);
      await residency.noteArrival(candidate, {
        decision: "fetch",
        sizeClass: await residency.classOf(candidate),
        // Not a decision the policy made. The bytes are already on disk by the
        // time this runs — the app wrote them — so this is accounting, exactly
        // as it is for an on-demand fetch.
        reason: "explicit-request",
      });
    },

    async touch(appId: string, blob: AppBlobIdentity, atMs: number): Promise<void> {
      residency?.touchAppBlob(blob.objectStorageKey, atMs);
    },

    async drop(appId: string, blob: AppBlobIdentity): Promise<AppBlobDropResult> {
      // A node with no residency manager has no resident set to mark departed
      // and no durability policy to check against. Refused rather than done
      // blindly: deleting bytes is the operation in this file that cannot be
      // undone, and doing it with none of the machinery that decides whether it
      // is safe is exactly the shape of a data-loss bug.
      if (residency === null) return { dropped: false, reason: "refused" };
      const outcome = await residency.dropAppBlob(appId, blob, probes(appId));
      return {
        dropped: outcome.dropped,
        reason: outcome.reason,
        ...(outcome.durability === null
          ? {}
          : { confirmedReplicas: outcome.durability.confirmedReplicas }),
      };
    },

    async fetch(appId: string, blob: AppBlobIdentity): Promise<AppBlobFetchResult> {
      const engine = engineFor(appId);
      if (engine === null) return { landed: false, reason: "unavailable" };
      // Answered before the acquire, because nothing after it can answer it.
      // The transfer short-circuits on a destination that already holds the
      // key and reports that identically to a real download, so an app asking
      // twice would be told twice that bytes moved.
      //
      // The index rather than the object store: a row that says resident is
      // this node's own accounting, and the one case where the two disagree —
      // bytes on disk that no budget knows about — must go through the acquire
      // below, whose accounting is what corrects it.
      if (residency !== null && residency.index.get(blob.objectStorageKey)?.resident === true) {
        // Still an open. The request is somebody asking for these bytes
        // whether or not a transfer was needed to answer it.
        residency.touchAppBlob(blob.objectStorageKey, Date.now());
        return { landed: true, reason: "already-here" };
      }
      // `acquireBlob` with the `request` trigger, not `fetchBlob`. The
      // difference is the whole point: `fetchBlob` bypasses the residency
      // decision entirely, and this path wants exactly one rule set aside.
      // Every app blob is `prefetch: false` now, so without the trigger the
      // decision would decline; with it, an operator who has budgeted this app
      // to nothing is still honoured.
      //
      // The transfer short-circuits when the destination already has the key,
      // so asking for bytes that are here costs one HEAD rather than a
      // download.
      // The request is the open. Ranking it never-opened would put the blob
      // somebody just asked for at the front of the queue to be given up.
      const result = await engine.acquireBlob(
        manifestFor(blob),
        candidateFor(appId, blob, Date.now()),
        "request",
      );
      if (result.outcome === "landed") return { landed: true, reason: "landed" };
      if (result.outcome === "declined") return { landed: false, reason: "declined" };
      return { landed: false, reason: "unavailable" };
    },
  };
}
