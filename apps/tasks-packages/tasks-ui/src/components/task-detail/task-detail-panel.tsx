import React from "react";
import type { TdoFileContent } from "@tasks/tasks-lib";
import { useTask } from "../../context/task-context.js";
import { TaskForm } from "./task-form.js";
import { CommentThread } from "./comment-thread.js";
import { HistoryLog } from "./history-log.js";

interface HistoryEntry {
  entryId: string;
  timestamp: string;
  actorId: string;
  changes: Record<string, { from: unknown; to: unknown }>;
}

interface TaskDetailPanelProps {
  onUpdate: (id: string, updates: Partial<TdoFileContent>) => void;
  historyEntries?: HistoryEntry[];
  onAddComment?: (taskId: string, content: string) => void;
}

export function TaskDetailPanel({
  onUpdate,
  historyEntries = [],
  onAddComment,
}: TaskDetailPanelProps) {
  const { selectedTask } = useTask();

  if (!selectedTask) {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          height: "100%",
          color: "#94a3b8",
          padding: "32px",
          textAlign: "center",
        }}
      >
        <div
          style={{
            fontSize: "48px",
            marginBottom: "16px",
            opacity: 0.4,
          }}
        >
          &#9744;
        </div>
        <p style={{ fontSize: "15px", fontWeight: 500, margin: 0 }}>
          No task selected
        </p>
        <p
          style={{
            fontSize: "13px",
            color: "#cbd5e1",
            marginTop: "8px",
          }}
        >
          Select a task from the list to view details
        </p>
      </div>
    );
  }

  const handleUpdate = (updates: Partial<TdoFileContent>) => {
    onUpdate(selectedTask.id, updates);
  };

  const handleAddComment = (content: string) => {
    onAddComment?.(selectedTask.id, content);
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          padding: "12px 16px",
          borderBottom: "1px solid #e2e8f0",
          fontWeight: 600,
          fontSize: "14px",
          color: "#1e293b",
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <span>Task Details</span>
        <span style={{ fontSize: "11px", fontWeight: 400, color: "#94a3b8" }}>
          {selectedTask.id}
        </span>
      </div>

      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "20px 20px",
          display: "flex",
          flexDirection: "column",
          gap: "32px",
        }}
      >
        <TaskForm task={selectedTask} onUpdate={handleUpdate} />

        <hr
          style={{
            border: "none",
            borderTop: "1px solid #e2e8f0",
            margin: 0,
          }}
        />

        <CommentThread
          comments={selectedTask.comments}
          onAddComment={handleAddComment}
        />

        <hr
          style={{
            border: "none",
            borderTop: "1px solid #e2e8f0",
            margin: 0,
          }}
        />

        <HistoryLog entries={historyEntries} />
      </div>
    </div>
  );
}
