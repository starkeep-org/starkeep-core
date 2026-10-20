// Object-storage key construction. Single source of truth for every node and
// the cloud Lambda handler so they stay aligned.
//
// Two namespaces, each with the owning user's segment:
//   shared/<userId>/<category>/<2-char>/<hash>
//                                        data record blobs, bucketed by the
//                                        derived category (image, document, …,
//                                        other). Governed by the per-app
//                                        access path + the per-category IAM
//                                        ceiling (shared/<userId>/<category>/*
//                                        per granted category, the user from
//                                        the session's `starkeep:userId` tag).
//   apps/<appId>/<userId>/syncable/<...> app-specific syncable files, owned by
//                                        the named app and user, synced as a
//                                        unit with the rest of that app's
//                                        syncable data
//
// The same key names the same object on every node and in S3, so a key is
// never translated on its way through sync. Each user's data lives under its
// own segment, which is what lets IAM keep one user's sessions out of another
// user's objects. A library no cloud has bound to a user writes under
// `LOCAL_USER_SEGMENT`, and binding renames that segment once.
//
// The prefix is determined by what is being stored, NOT by who is writing it.
// A `kind:"data"` record blob always lives under `shared/<userId>/<category>/...`,
// even when an app with `readwrite` access produced it — that's how a
// different app with read access to the same category can resolve the key
// under its own IAM grants, and it keeps the prefix set bounded (~11 per user)
// so `other`/unmapped files are enumerable. The system does not provide an
// app-private non-syncable namespace; apps that want such storage handle it
// themselves.
//
// See `~/projects/starkeep/plan-multi-user-roles-2026-10-16.md`, step 4.5.

import { typeCategory } from "../types/core-types.js";

/**
 * The user segment of a library that no cloud has bound to a user yet. The
 * library's first successful contact with a cloud renames it to the user's id.
 */
export const LOCAL_USER_SEGMENT = "local";

/**
 * The shape a user segment must have: a Cognito `sub` (a UUID) or
 * {@link LOCAL_USER_SEGMENT}. It becomes a path segment, so nothing that could
 * address another prefix gets through.
 */
export const USER_SEGMENT_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function checkUserSegment(fn: string, userId: string): void {
  if (!USER_SEGMENT_PATTERN.test(userId)) {
    throw new Error(`${fn}: invalid user segment ${JSON.stringify(userId)}`);
  }
}

// `type` is the record's canonical Starkeep type (`<category>/<format>`). The
// category is its prefix, so the key stays category-bucketed and
// `other/*`/unmapped records land under `shared/<userId>/other/...`.
export function dataRecordObjectKey(userId: string, type: string, contentHash: string): string {
  checkUserSegment("dataRecordObjectKey", userId);
  const shard = contentHash.slice(0, 2);
  return `shared/${userId}/${typeCategory(type)}/${shard}/${contentHash}`;
}

// Recover the content hash a `shared/<userId>/<category>/<shard>/<hash>` key
// names, or null if the key isn't one of ours in that exact shape.
//
// This is what makes upload verification free: the key already *is* the
// SHA-256, so a signer can pin the expected checksum from the key alone and
// never has to trust an uploader-supplied value. The shard must agree with the
// hash — a key whose shard doesn't match its hash was not built by
// `dataRecordObjectKey` and is rejected rather than trusted.
//
// App-syncable keys are deliberately not content-addressed and always return
// null here; they carry no derivable checksum.
export function contentHashFromDataRecordObjectKey(key: string): string | null {
  const segments = key.split("/");
  if (segments.length !== 5) return null;
  const [namespace, userId, , shard, hash] = segments as [string, string, string, string, string];
  if (namespace !== "shared") return null;
  if (!USER_SEGMENT_PATTERN.test(userId)) return null;
  if (!/^[a-f0-9]{64}$/.test(hash)) return null;
  if (shard !== hash.slice(0, 2)) return null;
  return hash;
}

/**
 * The owning user's segment of a key in either namespace, or null for a key
 * outside both. The cloud refuses a key whose segment is not the caller's.
 */
export function userIdFromObjectKey(key: string): string | null {
  const segments = key.split("/");
  let candidate: string | undefined;
  if (segments[0] === "shared" && segments.length >= 3) candidate = segments[1];
  else if (segments[0] === "apps" && segments.length >= 4 && segments[3] === "syncable")
    candidate = segments[2];
  return candidate !== undefined && USER_SEGMENT_PATTERN.test(candidate) ? candidate : null;
}

/**
 * The category of a `shared/<userId>/<category>/...` key, or null for any
 * other key.
 */
export function categoryFromSharedObjectKey(key: string): string | null {
  const segments = key.split("/");
  if (segments[0] !== "shared" || segments.length < 4) return null;
  return segments[2] ?? null;
}

/**
 * The same key under another user's segment, or the key unchanged when it
 * carries no user segment. Binding a library renames every key from
 * {@link LOCAL_USER_SEGMENT} to the user's id with this.
 */
export function rebindObjectKey(key: string, toUserId: string): string {
  checkUserSegment("rebindObjectKey", toUserId);
  const segments = key.split("/");
  if (userIdFromObjectKey(key) === null) return key;
  if (segments[0] === "shared") segments[1] = toUserId;
  else segments[2] = toUserId;
  return segments.join("/");
}

/** The prefix every shared object of one user lives under. */
export function sharedObjectPrefix(userId: string): string {
  checkUserSegment("sharedObjectPrefix", userId);
  return `shared/${userId}/`;
}

/** The prefix every syncable file of one app and one user lives under. */
export function appSyncableObjectPrefix(appId: string, userId: string): string {
  if (!appId || /[/\s]/.test(appId)) {
    throw new Error(`appSyncableObjectPrefix: invalid appId ${JSON.stringify(appId)}`);
  }
  checkUserSegment("appSyncableObjectPrefix", userId);
  return `apps/${appId}/${userId}/syncable/`;
}

// Build the canonical object key for an app's syncable file. `subKey` is the
// app-relative path under apps/<appId>/<userId>/syncable/. Idempotent if the
// caller already passed a fully qualified key for the same app and user.
// Rejects keys that would escape the namespace (`..` segments, absolute paths).
export function appSyncableObjectKey(appId: string, userId: string, subKey: string): string {
  const prefix = appSyncableObjectPrefix(appId, userId);
  const relative = subKey.startsWith(prefix) ? subKey.slice(prefix.length) : subKey;
  if (relative.startsWith("/")) {
    throw new Error(
      `appSyncableObjectKey: subKey must not start with "/" (got ${JSON.stringify(subKey)})`,
    );
  }
  const segments = relative.split("/");
  if (segments.some((s) => s === "..")) {
    throw new Error(
      `appSyncableObjectKey: subKey must not contain ".." (got ${JSON.stringify(subKey)})`,
    );
  }
  return `${prefix}${relative}`;
}
