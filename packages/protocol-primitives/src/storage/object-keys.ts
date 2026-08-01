// Object-storage key construction. Single source of truth for both the
// local SDK and the cloud Lambda handler so the two stay aligned.
//
// Two namespaces:
//   shared/<category>/<2-char>/<hash>    data record blobs, bucketed by the
//                                        derived category (image, document, …,
//                                        other). Governed by the per-app
//                                        access path + the per-category IAM
//                                        ceiling (shared/<category>/* per
//                                        granted category; Drive gets shared/*).
//   apps/<appId>/syncable/<...>          app-specific syncable files, owned by
//                                        the named app, synced as a unit with
//                                        the rest of that app's syncable data
//
// The prefix is determined by what is being stored, NOT by who is writing it.
// A `kind:"data"` record blob always lives under `shared/<category>/...`, even
// when an app with `readwrite` access produced it — that's how a different app
// with read access to the same category can resolve the key under its own IAM
// grants, and it keeps the prefix set bounded (~11) so `other`/unmapped files
// are enumerable. The system does not provide an app-private non-syncable
// namespace; apps that want such storage handle it themselves.

import { typeCategory } from "../types/core-types.js";

// `type` is the record's canonical Starkeep type (`<category>/<format>`). The
// category is its prefix, so the key stays category-bucketed and
// `other/*`/unmapped records land under `shared/other/...`.
export function dataRecordObjectKey(type: string, contentHash: string): string {
  const shard = contentHash.slice(0, 2);
  return `shared/${typeCategory(type)}/${shard}/${contentHash}`;
}

// Recover the content hash a `shared/<category>/<shard>/<hash>` key names, or
// null if the key isn't one of ours in that exact shape.
//
// This is what makes upload verification free: the key already *is* the
// SHA-256, so a signer can pin the expected checksum from the key alone and
// never has to trust an uploader-supplied value. The shard must agree with the
// hash — a key whose shard doesn't match its hash was not built by
// `dataRecordObjectKey` and is rejected rather than trusted.
//
// App-syncable keys (`apps/<appId>/syncable/...`) are deliberately not
// content-addressed and always return null here; they carry no derivable
// checksum.
export function contentHashFromDataRecordObjectKey(key: string): string | null {
  const segments = key.split("/");
  if (segments.length !== 4) return null;
  const [namespace, , shard, hash] = segments as [string, string, string, string];
  if (namespace !== "shared") return null;
  if (!/^[a-f0-9]{64}$/.test(hash)) return null;
  if (shard !== hash.slice(0, 2)) return null;
  return hash;
}

// Build the canonical object key for an app's syncable file. `subKey` is the
// app-relative path under apps/<appId>/syncable/. Idempotent if the caller
// already passed a fully qualified key. Rejects keys that would escape the
// namespace (`..` segments, absolute paths).
export function appSyncableObjectKey(appId: string, subKey: string): string {
  if (!appId || /[/\s]/.test(appId)) {
    throw new Error(`appSyncableObjectKey: invalid appId ${JSON.stringify(appId)}`);
  }
  const prefix = `apps/${appId}/syncable/`;
  const relative = subKey.startsWith(prefix) ? subKey.slice(prefix.length) : subKey;
  if (relative.startsWith("/")) {
    throw new Error(`appSyncableObjectKey: subKey must not start with "/" (got ${JSON.stringify(subKey)})`);
  }
  const segments = relative.split("/");
  if (segments.some((s) => s === "..")) {
    throw new Error(`appSyncableObjectKey: subKey must not contain ".." (got ${JSON.stringify(subKey)})`);
  }
  return `${prefix}${relative}`;
}
