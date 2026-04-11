import React from "react";
import type { Task, TaskStatus } from "@tasks/tasks-lib";
import { useTask } from "../../context/task-context.js";

interface TaskCardProps {
  task: Task;
  isSelected: boolean;
  onClick: () => void;
}

const STATUS_COLORS: Record<TaskStatus, { bg: string; text: string }> = {
  Blocked: { bg: "#fee2e2", text: "#dc2626" },
  Backlog: { bg: "#f1f5f9", text: "#475569" },
  Todo: { bg: "#eff6ff", text: "#2563eb" },
  "In Progress": { bg: "#fef3c7", text: "#d97706" },
  Done: { bg: "#dcfce7", text: "#16a34a" },
};

export function TaskCard({ task, isSelected, onClick }: TaskCardProps) {
  const { dispatch } = useTask();

  const handleClick = () => {
    dispatch({ type: "SELECT_TASK", id: task.id });
    onClick();
  };

  const statusColors = STATUS_COLORS[task.status] ?? {
    bg: "#f1f5f9",
    text: "#475569",
  };

  const visibleBlockers = task.blockers.slice(0, 2);

  return (
    <div
      onClick={handleClick}
      style={{
        padding: "12px 16px",
        borderBottom: "1px solid #e2e8f0",
        backgroundColor: isSelected ? "#eff6ff" : "#ffffff",
        cursor: "pointer",
        borderLeft: isSelected ? "3px solid #3b82f6" : "3px solid transparent",
        transition: "background-color 0.1s",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: "8px",
          marginBottom: "6px",
        }}
      >
        <span
          style={{
            fontSize: "14px",
            fontWeight: 500,
            color: "#1e293b",
            lineHeight: "1.4",
            flex: 1,
          }}
        >
          {task.title}
        </span>
        <span
          style={{
            fontSize: "11px",
            fontWeight: 600,
            padding: "2px 8px",
            borderRadius: "999px",
            backgroundColor: statusColors.bg,
            color: statusColors.text,
            whiteSpace: "nowrap",
            flexShrink: 0,
          }}
        >
          {task.status}
        </span>
      </div>

      {task.assignee && (
        <div
          style={{
            fontSize: "12px",
            color: "#64748b",
            marginBottom: "4px",
          }}
        >
          {task.assignee}
        </div>
      )}

      {task.labels.length > 0 && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "4px",
            marginBottom: "4px",
          }}
        >
          {task.labels.map((label) => (
            <span
              key={label}
              style={{
                fontSize: "11px",
                padding: "1px 6px",
                borderRadius: "4px",
                backgroundColor: "#f1f5f9",
                color: "#64748b",
                border: "1px solid #e2e8f0",
              }}
            >
              {label}
            </span>
          ))}
        </div>
      )}

      {visibleBlockers.length > 0 && (
        <div style={{ marginTop: "4px" }}>
          {visibleBlockers.map((blocker, i) => (
            <div
              key={i}
              style={{
                fontSize: "11px",
                color: "#dc2626",
                display: "flex",
                alignItems: "center",
                gap: "4px",
              }}
            >
              <span>&#9632;</span>
              <span>
                {blocker.type === "task"
                  ? `Blocked by task ${blocker.taskId}`
                  : blocker.description}
              </span>
            </div>
          ))}
          {task.blockers.length > 2 && (
            <div
              style={{
                fontSize: "11px",
                color: "#94a3b8",
              }}
            >
              +{task.blockers.length - 2} more blocker
              {task.blockers.length - 2 > 1 ? "s" : ""}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
