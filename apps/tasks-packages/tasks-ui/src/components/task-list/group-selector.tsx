import React, { useState, useRef, useEffect } from "react";
import type { TaskGroup } from "@tasks/tasks-lib";

interface GroupSelectorProps {
  groups: TaskGroup[];
  activeGroupId: string | null;
  onSelectGroup: (groupId: string) => void;
  onCreateGroup: (name: string) => Promise<void>;
}

export function GroupSelector({
  groups,
  activeGroupId,
  onSelectGroup,
  onCreateGroup,
}: GroupSelectorProps) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const activeGroup = groups.find((g) => g.id === activeGroupId);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setCreating(false);
        setNewName("");
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name || isSubmitting) return;
    setIsSubmitting(true);
    try {
      await onCreateGroup(name);
      setNewName("");
      setCreating(false);
      setOpen(false);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "4px",
          background: open ? "#f1f5f9" : "none",
          border: "1px solid transparent",
          borderRadius: "6px",
          padding: "3px 8px",
          cursor: "pointer",
          fontSize: "12px",
          color: "#64748b",
          fontFamily: "inherit",
          transition: "background 0.1s",
        }}
      >
        <span style={{ fontWeight: 500, color: "#475569" }}>
          {activeGroup?.payload.name ?? "No group"}
        </span>
        <span style={{ fontSize: "9px", color: "#94a3b8" }}>▾</span>
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            right: 0,
            zIndex: 100,
            background: "#fff",
            border: "1px solid #e2e8f0",
            borderRadius: "8px",
            boxShadow: "0 4px 16px rgba(0,0,0,0.08)",
            minWidth: "180px",
            overflow: "hidden",
          }}
        >
          {groups.length === 0 && (
            <p
              style={{
                padding: "8px 12px",
                fontSize: "12px",
                color: "#94a3b8",
                margin: 0,
              }}
            >
              No groups yet
            </p>
          )}

          {groups.map((group) => (
            <button
              key={group.id}
              onClick={() => {
                onSelectGroup(group.id);
                setOpen(false);
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                width: "100%",
                padding: "8px 12px",
                background: group.id === activeGroupId ? "#f8fafc" : "none",
                border: "none",
                cursor: "pointer",
                fontSize: "13px",
                color: "#1e293b",
                textAlign: "left",
                fontFamily: "inherit",
              }}
            >
              <span style={{ width: "12px", color: "#3b82f6", fontSize: "11px" }}>
                {group.id === activeGroupId ? "✓" : ""}
              </span>
              {group.payload.name}
            </button>
          ))}

          <div
            style={{
              borderTop: groups.length > 0 ? "1px solid #e2e8f0" : "none",
              padding: "6px",
            }}
          >
            {creating ? (
              <div style={{ display: "flex", gap: "4px" }}>
                <input
                  autoFocus
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleCreate();
                    if (e.key === "Escape") {
                      setCreating(false);
                      setNewName("");
                    }
                  }}
                  placeholder="Group name"
                  disabled={isSubmitting}
                  style={{
                    flex: 1,
                    border: "1px solid #cbd5e1",
                    borderRadius: "4px",
                    padding: "4px 8px",
                    fontSize: "12px",
                    fontFamily: "inherit",
                    outline: "none",
                    color: "#1e293b",
                  }}
                />
                <button
                  onClick={handleCreate}
                  disabled={isSubmitting || !newName.trim()}
                  style={{
                    padding: "4px 10px",
                    border: "none",
                    borderRadius: "4px",
                    background: "#3b82f6",
                    color: "#fff",
                    fontSize: "12px",
                    cursor: isSubmitting || !newName.trim() ? "default" : "pointer",
                    opacity: isSubmitting || !newName.trim() ? 0.5 : 1,
                    fontFamily: "inherit",
                  }}
                >
                  Add
                </button>
              </div>
            ) : (
              <button
                onClick={() => setCreating(true)}
                style={{
                  width: "100%",
                  padding: "4px 8px",
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  fontSize: "12px",
                  color: "#64748b",
                  textAlign: "left",
                  fontFamily: "inherit",
                  borderRadius: "4px",
                }}
              >
                + New group
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
