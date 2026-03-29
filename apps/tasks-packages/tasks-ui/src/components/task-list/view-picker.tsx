import React from "react";
import type { TaskListView } from "@tasks/tasks-lib";

interface ViewPickerProps {
  views: TaskListView[];
  activeViewId: string;
  onSelect: (viewId: string) => void;
}

export function ViewPicker({ views, activeViewId, onSelect }: ViewPickerProps) {
  return (
    <div
      style={{
        display: "flex",
        overflowX: "auto",
        borderBottom: "1px solid #e2e8f0",
        backgroundColor: "#f8fafc",
        scrollbarWidth: "none",
      }}
    >
      {views.map((view) => {
        const isActive = view.viewId === activeViewId;
        return (
          <button
            key={view.viewId}
            onClick={() => onSelect(view.viewId)}
            style={{
              padding: "10px 16px",
              border: "none",
              borderBottom: isActive ? "2px solid #3b82f6" : "2px solid transparent",
              backgroundColor: "transparent",
              color: isActive ? "#3b82f6" : "#64748b",
              fontWeight: isActive ? 600 : 400,
              fontSize: "13px",
              cursor: "pointer",
              whiteSpace: "nowrap",
              flexShrink: 0,
              transition: "color 0.1s",
            }}
          >
            {view.label}
          </button>
        );
      })}
    </div>
  );
}
