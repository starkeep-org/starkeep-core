"use client";

import { useEffect, useState } from "react";

interface DriveRecord {
  id: string;
  type: string;
  origin_app_id: string;
  updated_at: string;
  size_bytes: number | null;
  original_filename: string | null;
  mime_type: string | null;
}

interface DriveTypeSummary {
  record_type: string;
  count: number;
}

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
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/types")
      .then((r) => r.json())
      .then((d: { types?: DriveTypeSummary[]; error?: string }) => {
        if (d.types) setTypes(d.types);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    setLoading(true);
    setError(null);
    const qs = activeType ? `?type=${encodeURIComponent(activeType)}` : "";
    fetch(`/api/records${qs}`)
      .then(async (r) => {
        const d = (await r.json()) as { records?: DriveRecord[]; error?: string };
        if (!r.ok) throw new Error(d.error ?? `${r.status}`);
        setRecords(d.records ?? []);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [activeType]);

  return (
    <main>
      <h1>Starkeep Drive</h1>
      <p className="subtitle">
        Everything you own across all your apps — including data from apps that
        aren&apos;t cloud-installed. Read-only.
      </p>

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

      {error && (
        <div className="notice error">
          Couldn&apos;t load records: {error}
        </div>
      )}

      {!error && loading && <div className="notice">Loading…</div>}

      {!error && !loading && records.length === 0 && (
        <div className="notice">No shared records yet.</div>
      )}

      {!error && !loading && records.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Type</th>
              <th>Name</th>
              <th>From (origin app)</th>
              <th>Size</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {records.map((r) => (
              <tr key={r.id}>
                <td>{r.type}</td>
                <td title={r.original_filename ?? r.id}>
                  {r.original_filename ?? r.id}
                </td>
                <td>
                  <span className="origin">{r.origin_app_id}</span>
                </td>
                <td>{formatBytes(r.size_bytes)}</td>
                <td>{new Date(r.updated_at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
