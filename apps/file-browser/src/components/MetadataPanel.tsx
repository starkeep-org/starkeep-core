import { useEffect, useState } from "react";
import { getRecordMetadata, type DataRecord, type MetadataEntry } from "../lib/client.ts";

interface Props {
  record: DataRecord;
  onClose: () => void;
}

export default function MetadataPanel({ record, onClose }: Props) {
  const [entries, setEntries] = useState<MetadataEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    getRecordMetadata(record.id)
      .then(setEntries)
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : "Failed to load metadata"),
      )
      .finally(() => setLoading(false));
  }, [record.id]);

  return (
    <aside className="metadata-panel">
      <div className="panel-header">
        <h2>Metadata</h2>
        <button className="close-btn" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>

      <div className="panel-body">
        <section className="panel-section">
          <h3>Record</h3>
          <dl className="record-fields">
            <dt>ID</dt>
            <dd className="mono">{record.id}</dd>
            <dt>Type</dt>
            <dd><code>{record.type}</code></dd>
            <dt>MIME type</dt>
            <dd>{record.mime_type ?? "—"}</dd>
            <dt>Size</dt>
            <dd>{record.size_bytes != null ? `${record.size_bytes.toLocaleString()} bytes` : "—"}</dd>
            <dt>Sync status</dt>
            <dd><span className={`badge badge-${record.sync_status}`}>{record.sync_status}</span></dd>
            <dt>Created</dt>
            <dd>{new Date(record.created_at).toLocaleString()}</dd>
            <dt>Updated</dt>
            <dd>{new Date(record.updated_at).toLocaleString()}</dd>
          </dl>
        </section>

        <section className="panel-section">
          <h3>Payload</h3>
          <pre className="json-block">
            {JSON.stringify(record.payload, null, 2)}
          </pre>
        </section>

        <section className="panel-section">
          <h3>Metadata entries</h3>
          {loading && <p className="panel-loading">Loading…</p>}
          {error && <p className="panel-error">{error}</p>}
          {!loading && !error && entries.length === 0 && (
            <p className="panel-empty">No metadata entries for this record.</p>
          )}
          {!loading && entries.length > 0 && (
            <div className="meta-entries">
              {entries.map((e, i) => (
                <div key={i} className="meta-entry">
                  <div className="meta-entry-header">
                    <code className="generator-id">{e.generatorId}</code>
                    <span className="meta-version">v{e.generatorVersion}</span>
                    <span className="meta-date">
                      {new Date(e.updatedAt).toLocaleString()}
                    </span>
                  </div>
                  <pre className="json-block">
                    {JSON.stringify(e.value, null, 2)}
                  </pre>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </aside>
  );
}
