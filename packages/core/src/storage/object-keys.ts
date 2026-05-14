// Object-storage key construction. Single source of truth for both the
// local SDK and the cloud Lambda handler so the two stay aligned.
//
// Two namespaces:
//   shared/<typeId>/<2-char>/<hash>   data record blobs, governed by
//                                     shared.access_grants / shared_access_grants
//   apps/<appId>/<...>                anything app-private; the app organizes
//                                     its own subtree
//
// The prefix is determined by what is being stored, NOT by who is writing it.
// A `kind:"data"` record blob always lives under `shared/<typeId>/...`, even
// when an app with `readwrite` access produced it — that's how a different
// app with read access to the same type can resolve the key under its own
// IAM grants.

export function dataRecordObjectKey(typeId: string, contentHash: string): string {
  const shard = contentHash.slice(0, 2);
  return `shared/${typeId}/${shard}/${contentHash}`;
}

export function appPrivateObjectKey(appId: string, subKey: string): string {
  const prefix = `apps/${appId}/`;
  return subKey.startsWith(prefix) ? subKey : `${prefix}${subKey}`;
}

export function appPrivateHashedKey(appId: string, contentHash: string): string {
  return appPrivateObjectKey(appId, `${contentHash.slice(0, 2)}/${contentHash}`);
}
