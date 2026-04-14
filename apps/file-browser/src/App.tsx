import { useEffect, useState } from "react";
import {
  listRecords,
  type DataRecord,
} from "./lib/client.ts";
import MetadataPanel from "./components/MetadataPanel.tsx";

function formatDate(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

export default function App() {
  const [records, setRecords] = useState<DataRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedRecord, setSelectedRecord] = useState<DataRecord | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const recs = await listRecords();
        setRecords(recs);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load data");
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, []);

  if (loading) {
    return (
      <div className="state-message">
        <span className="spinner" />
        Connecting to data-server…
      </div>
    );
  }

  if (error) {
    return (
      <div className="state-message error">
        <strong>Could not reach data-server</strong>
        <p>{error}</p>
        <p className="hint">Make sure the data-server is running on port 9820.</p>
      </div>
    );
  }

  return (
    <div className="layout">
      <header className="header">
        <h1>Starkeep File Browser</h1>
        <span className="record-count">{records.length} records</span>
      </header>

      <main className={`main ${selectedRecord ? "with-panel" : ""}`}>
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Object ID</th>
                <th>Filename</th>
                <th>Path</th>
                <th>Type</th>
                <th>Date Added</th>
                <th>Metadata</th>
              </tr>
            </thead>
            <tbody>
              {records.map((r) => {
                const filename =
                  typeof r.payload?.fileName === "string"
                    ? r.payload.fileName
                    : "—";
                const path = r.path ?? "—";
                return (
                  <tr
                    key={r.id}
                    className={selectedRecord?.id === r.id ? "selected" : ""}
                  >
                    <td className="cell-id">
                      <span title={r.id}>{r.id.slice(0, 12)}…</span>
                    </td>
                    <td className="cell-filename">{filename}</td>
                    <td className="cell-path" title={path}>
                      {path}
                    </td>
                    <td className="cell-type">
                      <code>{r.type}</code>
                    </td>
                    <td className="cell-date">{formatDate(r.created_at)}</td>
                    <td className="cell-action">
                      <button
                        className="link-btn"
                        onClick={() =>
                          setSelectedRecord(
                            selectedRecord?.id === r.id ? null : r,
                          )
                        }
                      >
                        {selectedRecord?.id === r.id ? "Close" : "Metadata"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {records.length === 0 && (
            <div className="empty">No records found in the index.</div>
          )}
        </div>

        {selectedRecord && (
          <MetadataPanel
            record={selectedRecord}
            onClose={() => setSelectedRecord(null)}
          />
        )}
      </main>
    </div>
  );
}
