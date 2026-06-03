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

import { categoryOf } from "../types/core-types.js";

// `typeOrExt` is the record's `type` (lowercase extension). The category is
// derived here so the key stays category-bucketed and unmapped/extension-less
// records land under `shared/other/...`.
export function dataRecordObjectKey(typeOrExt: string, contentHash: string): string {
  const shard = contentHash.slice(0, 2);
  return `shared/${categoryOf(typeOrExt)}/${shard}/${contentHash}`;
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
