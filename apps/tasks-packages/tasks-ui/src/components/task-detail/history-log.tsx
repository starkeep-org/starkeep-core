import React from "react";

interface HistoryEntry {
  entryId: string;
  timestamp: string;
  actorId: string;
  changes: Record<string, { from: unknown; to: unknown }>;
}

interface HistoryLogProps {
  entries: HistoryEntry[];
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "(empty)";
  if (typeof value === "string") return value || "(empty)";
  return JSON.stringify(value);
}

export function HistoryLog({ entries }: HistoryLogProps) {
  if (entries.length === 0) {
    return (
      <div>
        <h3
          style={{
            fontSize: "13px",
            fontWeight: 600,
            color: "#64748b",
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            marginBottom: "12px",
          }}
        >
          History
        </h3>
        <p style={{ fontSize: "13px", color: "#94a3b8" }}>No history yet.</p>
      </div>
    );
  }

  return (
    <div>
      <h3
        style={{
          fontSize: "13px",
          fontWeight: 600,
          color: "#64748b",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          marginBottom: "12px",
        }}
      >
        History
      </h3>

      <div
        style={{
          position: "relative",
          paddingLeft: "16px",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: "4px",
            top: "6px",
            bottom: "6px",
            width: "2px",
            backgroundColor: "#e2e8f0",
          }}
        />
        {entries.map((entry) => (
          <div
            key={entry.entryId}
            style={{
              position: "relative",
              marginBottom: "16px",
            }}
          >
            <div
              style={{
                position: "absolute",
                left: "-14px",
                top: "5px",
                width: "8px",
                height: "8px",
                borderRadius: "50%",
                backgroundColor: "#94a3b8",
                border: "2px solid #f8fafc",
              }}
            />
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: "4px",
              }}
            >
              <span style={{ fontSize: "12px", fontWeight: 600, color: "#475569" }}>
                {entry.actorId}
              </span>
              <span style={{ fontSize: "11px", color: "#94a3b8" }}>
                {new Date(entry.timestamp).toLocaleString()}
              </span>
            </div>
            <div>
              {Object.entries(entry.changes).map(([field, { from, to }]) => (
                <div
                  key={field}
                  style={{
                    fontSize: "12px",
                    color: "#64748b",
                    marginBottom: "2px",
                  }}
                >
                  <span style={{ fontWeight: 500, color: "#475569" }}>
                    {field}
                  </span>
                  {": "}
                  <span
                    style={{
                      textDecoration: "line-through",
                      color: "#94a3b8",
                    }}
                  >
                    {formatValue(from)}
                  </span>
                  {" → "}
                  <span style={{ color: "#1e293b" }}>{formatValue(to)}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
