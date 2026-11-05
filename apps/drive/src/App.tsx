import { useCallback, useEffect, useRef, useState } from "react";
import { fileLinkHref } from "@/lib/file-link";
import {
  LinksView,
  ShareLinkDialog,
  shareBlockedReason,
  type CloudAvailability,
  type PublicLinksState,
} from "@/PublicLinks";

type SyncStatus = "local-only" | "synced" | "modified-locally" | "cloud-only";

interface DriveRecord {
  id: string;
  type?: string;
  category?: string;
  origin_app_id?: string;
  updated_at?: string;
  size_bytes?: number | null;
  original_filename?: string | null;
  mime_type?: string | null;
  object_storage_key?: string | null;
  sync_status: SyncStatus;
  cloud_availability?: CloudAvailability | null;
}

interface DriveTypeSummary {
  record_type: string;
  count: number;
}

interface CloudInfo {
  available: boolean;
  error?: string | null;
}

interface TrashedRecord extends DriveRecord {
  deleted_at?: string | null;
  /** When the reaper becomes free to reclaim the bytes; null when unknown. */
  deletes_at: string | null;
}

interface TrashPolicy {
  retention_days: number | null;
  default_retention_days: number;
  knows_library_value: boolean;
}

/** Which part of the library is on screen: what is here, what has gone, or what is shared. */
type View = "library" | "trash" | "links";

const SYNC_LABEL: Record<SyncStatus, string> = {
  "local-only": "Local only",
  synced: "Synced",
  "modified-locally": "Modified locally",
  "cloud-only": "Cloud only",
};

/** The cloud's archive state, beside the sync status, when the original is not readable now. */
const ARCHIVE_LABEL: Partial<Record<CloudAvailability, string>> = {
  archived: "Archived",
  restoring: "Restoring",
};

function formatBytes(n: number | null): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** "in 12 days", or "any time now" once the window has passed. */
function untilDeletion(iso: string): string {
  const days = Math.ceil((Date.parse(iso) - Date.now()) / (24 * 60 * 60 * 1000));
  if (Number.isNaN(days)) return "—";
  if (days <= 0) return "any time now";
  if (days === 1) return "tomorrow";
  return `in ${days} days`;
}

export function App() {
  const [types, setTypes] = useState<DriveTypeSummary[]>([]);
  const [records, setRecords] = useState<DriveRecord[]>([]);
  const [activeType, setActiveType] = useState<string | null>(null);
  const [cloud, setCloud] = useState<CloudInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<View>("library");
  const [trash, setTrash] = useState<TrashedRecord[]>([]);
  const [policy, setPolicy] = useState<TrashPolicy | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [links, setLinks] = useState<PublicLinksState | null>(null);
  const [sharing, setSharing] = useState<DriveRecord | null>(null);

  const loadLinks = useCallback(() => {
    fetch("/api/public-links")
      .then((r) => r.json())
      .then((d: PublicLinksState) => setLinks(d))
      .catch((e: unknown) =>
        setLinks({ available: false, reason: e instanceof Error ? e.message : String(e) }),
      );
  }, []);

  const loadTypes = useCallback(() => {
    fetch("/api/types")
      .then((r) => r.json())
      .then((d: { types?: DriveTypeSummary[]; error?: string }) => {
        if (d.types) setTypes(d.types);
      })
      .catch(() => {});
  }, []);

  const loadRecords = useCallback(
    (opts?: { silent?: boolean }) => {
      // A live-update refresh is silent — replacing the table with "Loading…"
      // on every remote write would flicker. Only the initial load and an
      // explicit type switch show the loading state.
      if (!opts?.silent) setLoading(true);
      setError(null);
      const qs = activeType ? `?type=${encodeURIComponent(activeType)}` : "";
      fetch(`/api/records${qs}`)
        .then(async (r) => {
          const d = (await r.json()) as {
            records?: DriveRecord[];
            cloud?: CloudInfo;
            error?: string;
          };
          if (!r.ok) throw new Error(d.error ?? `${r.status}`);
          setRecords(d.records ?? []);
          setCloud(d.cloud ?? null);
        })
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
        .finally(() => setLoading(false));
    },
    [activeType],
  );

  const loadTrash = useCallback((opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    setError(null);
    fetch("/api/trash")
      .then(async (r) => {
        const d = (await r.json()) as {
          records?: TrashedRecord[];
          policy?: TrashPolicy;
          error?: string;
        };
        if (!r.ok) throw new Error(d.error ?? `${r.status}`);
        setTrash(d.records ?? []);
        setPolicy(d.policy ?? null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  const restore = useCallback(
    (id: string) => {
      setRestoring(id);
      setError(null);
      fetch(`/api/trash/${encodeURIComponent(id)}/restore`, { method: "POST" })
        .then(async (r) => {
          const d = (await r.json()) as { error?: string };
          if (!r.ok) throw new Error(d.error ?? `${r.status}`);
          // Both halves move: the item leaves the Trash and rejoins the library.
          loadTrash({ silent: true });
          loadTypes();
        })
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
        .finally(() => setRestoring(null));
    },
    [loadTrash, loadTypes],
  );

  useEffect(() => {
    loadTypes();
  }, [loadTypes]);

  useEffect(() => {
    if (view === "trash") loadTrash();
    else loadRecords();
  }, [view, loadRecords, loadTrash]);

  // Whether Drive may make links decides the row buttons, so the list loads
  // with the page rather than with the Links view.
  useEffect(() => {
    loadLinks();
  }, [loadLinks]);

  // Live updates: subscribe to the LDS /events stream (proxied same-origin at
  // /api/events) and re-fetch on each kick, so a record added underneath the
  // page — by another app or the watcher — appears without a manual reload.
  // Refs keep one EventSource for the page's lifetime instead of reconnecting
  // every time the type filter changes the loaders' identity.
  const loadTypesRef = useRef(loadTypes);
  const loadRecordsRef = useRef(loadRecords);
  const loadTrashRef = useRef(loadTrash);
  const viewRef = useRef(view);
  loadTypesRef.current = loadTypes;
  loadRecordsRef.current = loadRecords;
  loadTrashRef.current = loadTrash;
  viewRef.current = view;

  useEffect(() => {
    const es = new EventSource("/api/events");
    es.onmessage = () => {
      loadTypesRef.current();
      // Only the half on screen: a kick is payload-less, so the page re-reads
      // whichever list the person is looking at rather than both.
      if (viewRef.current === "trash") loadTrashRef.current({ silent: true });
      else loadRecordsRef.current({ silent: true });
    };
    // The browser auto-reconnects an SSE source on transient errors; nothing to
    // do here beyond letting it.
    return () => es.close();
  }, []);

  return (
    <main>
      <h1>Starkeep Drive</h1>
      <p className="subtitle">
        Everything you own across all your apps — including data from apps that aren&apos;t
        cloud-installed. Each row shows whether it lives only on this device, only in the cloud, or
        is synced to both. The Trash lists what you have deleted, when each item goes for good, and
        lets you put one back. Links lists the files you have shared with a public link.
      </p>

      {cloud && !cloud.available && (
        <div className="notice warn">
          Showing local data only — cloud view unavailable
          {cloud.error ? `: ${cloud.error}` : "."}
        </div>
      )}

      <div className="toolbar">
        <button
          className={`chip${view === "library" ? " active" : ""}`}
          onClick={() => setView("library")}
        >
          Library
        </button>
        <button
          className={`chip${view === "trash" ? " active" : ""}`}
          onClick={() => setView("trash")}
        >
          Trash
        </button>
        <button
          className={`chip${view === "links" ? " active" : ""}`}
          onClick={() => {
            setView("links");
            loadLinks();
          }}
        >
          Links
        </button>
      </div>

      {view === "library" && (
        <div className="toolbar">
          <button
            className={`chip${activeType === null ? " active" : ""}`}
            onClick={() => setActiveType(null)}
          >
            All
          </button>
          {types.map((t) => (
            <button
              key={t.record_type}
              className={`chip${activeType === t.record_type ? " active" : ""}`}
              onClick={() => setActiveType(t.record_type)}
            >
              {t.record_type} ({t.count})
            </button>
          ))}
        </div>
      )}

      {error && <div className="notice error">Couldn&apos;t load records: {error}</div>}

      {!error && loading && <div className="notice">Loading…</div>}

      {view === "trash" && !error && !loading && (
        <TrashView records={trash} policy={policy} restoring={restoring} onRestore={restore} />
      )}

      {view === "links" && !error && !loading && (
        <LinksView state={links} records={records} onChanged={loadLinks} />
      )}

      {sharing && (
        <ShareLinkDialog
          record={sharing}
          mayPublish={links?.available === true && links.mayPublish}
          onClose={() => setSharing(null)}
          onCreated={loadLinks}
        />
      )}

      {view === "library" && !error && !loading && records.length === 0 && (
        <div className="notice">No shared records yet.</div>
      )}

      {view === "library" && !error && !loading && records.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Sync</th>
              <th>Category</th>
              <th>Type</th>
              <th>Name</th>
              <th>From (origin app)</th>
              <th>Size</th>
              <th>Updated</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {records.map((r) => {
              // The Name links through to the bytes only when the file is on
              // this device; fileLinkHref returns null for cloud-only rows and
              // records with no attached object. (See @/lib/file-link.)
              const name = r.original_filename ?? r.id;
              const href = fileLinkHref(r);
              const archive = r.cloud_availability
                ? ARCHIVE_LABEL[r.cloud_availability]
                : undefined;
              const blocked = links && !links.available ? links.reason : shareBlockedReason(r);
              return (
                <tr key={r.id}>
                  <td>
                    <span className={`badge ${r.sync_status}`}>{SYNC_LABEL[r.sync_status]}</span>
                    {archive && <span className="badge archived">{archive}</span>}
                  </td>
                  <td>{r.category ?? "—"}</td>
                  <td>{r.type || "—"}</td>
                  <td title={name}>
                    {href ? (
                      <a href={href} target="_blank" rel="noopener noreferrer">
                        {name}
                      </a>
                    ) : (
                      name
                    )}
                  </td>
                  <td>
                    <span className="origin">{r.origin_app_id ?? "—"}</span>
                  </td>
                  <td>{formatBytes(r.size_bytes ?? null)}</td>
                  <td>{r.updated_at ? new Date(r.updated_at).toLocaleString() : "—"}</td>
                  <td>
                    <button
                      className="row-action"
                      disabled={blocked !== null}
                      title={blocked ?? undefined}
                      onClick={() => setSharing(r)}
                    >
                      Share link…
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </main>
  );
}

/**
 * The Trash: what has been deleted, when each item goes for good, and the way back.
 *
 * The date is the point. A Trash without one promises nothing — an item that might
 * be reclaimed tomorrow and one that will still be there next year look identical —
 * so every row states it, and the window itself is stated once at the top because
 * it is a library-wide setting rather than a property of any item.
 *
 * No path column, deliberately. Where a file sat is a per-node fact held in the
 * watcher's private tracking table, which never syncs, and the record carries no
 * path at all. A Trash cannot promise one.
 */
function TrashView({
  records,
  policy,
  restoring,
  onRestore,
}: {
  records: TrashedRecord[];
  policy: TrashPolicy | null;
  restoring: string | null;
  onRestore: (id: string) => void;
}) {
  return (
    <>
      {policy && policy.retention_days === null && (
        <div className="notice warn">
          This machine cannot read the deployment&apos;s settings, so it does not know how long a
          deleted item is kept. Nothing will be reclaimed until it can.
        </div>
      )}
      {policy && policy.retention_days !== null && (
        <div className="notice" style={{ marginBottom: 16 }}>
          A deleted item is kept for {policy.retention_days} days, then its files are reclaimed.
          Restoring it before then brings it back whole.
        </div>
      )}

      {records.length === 0 && <div className="notice">Nothing deleted.</div>}

      {records.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Category</th>
              <th>Type</th>
              <th>Name</th>
              <th>Size</th>
              <th>Deleted</th>
              <th>Goes for good</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {records.map((r) => (
              <tr key={r.id}>
                <td>{r.category ?? "—"}</td>
                <td>{r.type || "—"}</td>
                <td title={r.original_filename ?? r.id}>{r.original_filename ?? r.id}</td>
                <td>{formatBytes(r.size_bytes ?? null)}</td>
                <td>{r.deleted_at ? new Date(r.deleted_at).toLocaleString() : "—"}</td>
                <td>
                  {r.deletes_at ? (
                    <span className="deletes-at" title={new Date(r.deletes_at).toLocaleString()}>
                      {untilDeletion(r.deletes_at)}
                    </span>
                  ) : (
                    <span className="deletes-at unknown">unknown</span>
                  )}
                </td>
                <td>
                  <button
                    className="row-action"
                    disabled={restoring !== null}
                    onClick={() => onRestore(r.id)}
                  >
                    {restoring === r.id ? "Restoring…" : "Restore"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
