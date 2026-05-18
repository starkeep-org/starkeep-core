// Object-storage key construction. Single source of truth for both the
// local SDK and the cloud Lambda handler so the two stay aligned.
//
// Two namespaces:
//   shared/<typeId>/<2-char>/<hash>      data record blobs, governed by
//                                        shared.access_grants / shared_access_grants
//   apps/<appId>/syncable/<...>          app-specific syncable files, owned by
//                                        the named app, synced as a unit with
//                                        the rest of that app's syncable data
//
// The prefix is determined by what is being stored, NOT by who is writing it.
// A `kind:"data"` record blob always lives under `shared/<typeId>/...`, even
// when an app with `readwrite` access produced it — that's how a different
// app with read access to the same type can resolve the key under its own
// IAM grants. The system does not provide an app-private non-syncable
// namespace; apps that want such storage handle it themselves.

export function dataRecordObjectKey(typeId: string, contentHash: string): string {
  const shard = contentHash.slice(0, 2);
  return `shared/${typeId}/${shard}/${contentHash}`;
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
