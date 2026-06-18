"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fileLinkHref } from "@/lib/file-link";

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
}

interface DriveTypeSummary {
  record_type: string;
  count: number;
}

interface CloudInfo {
  available: boolean;
  error?: string | null;
}

const SYNC_LABEL: Record<SyncStatus, string> = {
  "local-only": "Local only",
  synced: "Synced",
  "modified-locally": "Modified locally",
  "cloud-only": "Cloud only",
};

function formatBytes(n: number | null): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default function DrivePage() {
  const [types, setTypes] = useState<DriveTypeSummary[]>([]);
  const [records, setRecords] = useState<DriveRecord[]>([]);
  const [activeType, setActiveType] = useState<string | null>(null);
  const [cloud, setCloud] = useState<CloudInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

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

  useEffect(() => {
    loadTypes();
  }, [loadTypes]);

  useEffect(() => {
    loadRecords();
  }, [loadRecords]);

  // Live updates: subscribe to the LDS /events stream (proxied same-origin at
  // /api/events) and re-fetch on each kick, so a record added underneath the
  // page — by another app or the watcher — appears without a manual reload.
  // Refs keep one EventSource for the page's lifetime instead of reconnecting
  // every time the type filter changes the loaders' identity.
  const loadTypesRef = useRef(loadTypes);
  const loadRecordsRef = useRef(loadRecords);
  loadTypesRef.current = loadTypes;
  loadRecordsRef.current = loadRecords;

  useEffect(() => {
    const es = new EventSource("/api/events");
    es.onmessage = () => {
      loadTypesRef.current();
      loadRecordsRef.current({ silent: true });
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
        cloud-installed. Read-only. Each row shows whether it lives only on this device, only in the
        cloud, or is synced to both.
      </p>

      {cloud && !cloud.available && (
        <div className="notice warn">
          Showing local data only — cloud view unavailable
          {cloud.error ? `: ${cloud.error}` : "."}
        </div>
      )}

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

      {error && <div className="notice error">Couldn&apos;t load records: {error}</div>}

      {!error && loading && <div className="notice">Loading…</div>}

      {!error && !loading && records.length === 0 && (
        <div className="notice">No shared records yet.</div>
      )}

      {!error && !loading && records.length > 0 && (
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
            </tr>
          </thead>
          <tbody>
            {records.map((r) => {
              // The Name links through to the bytes only when the file is on
              // this device; fileLinkHref returns null for cloud-only rows and
              // records with no attached object. (See @/lib/file-link.)
              const name = r.original_filename ?? r.id;
              const href = fileLinkHref(r);
              return (
                <tr key={r.id}>
                  <td>
                    <span className={`badge ${r.sync_status}`}>{SYNC_LABEL[r.sync_status]}</span>
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
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </main>
  );
}
