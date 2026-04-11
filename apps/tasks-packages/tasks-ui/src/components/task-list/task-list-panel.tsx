import React, { useRef, useState } from "react";
import type { TaskGroup } from "@tasks/tasks-lib";
import { useTask } from "../../context/task-context.js";
import { useView } from "../../context/view-context.js";
import { TaskCard } from "./task-card.js";
import { ViewPicker } from "./view-picker.js";
import { GroupSelector } from "./group-selector.js";

interface TaskListPanelProps {
  onCreateTask: (title: string) => Promise<void>;
  groups?: TaskGroup[];
  activeGroupId?: string | null;
  onSelectGroup?: (groupId: string) => void;
  onCreateGroup?: (name: string) => Promise<void>;
}

export function TaskListPanel({
  onCreateTask,
  groups,
  activeGroupId,
  onSelectGroup,
  onCreateGroup,
}: TaskListPanelProps) {
  const { tasks, selectedTaskId } = useTask();
  const { activeView, savedViews, dispatch: dispatchView } = useView();
  const [quickAddValue, setQuickAddValue] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleViewSelect = (viewId: string) => {
    const view = savedViews.find((v) => v.viewId === viewId);
    if (view) {
      dispatchView({ type: "SET_VIEW", view });
    }
  };

  const handleQuickAddKeyDown = async (
    e: React.KeyboardEvent<HTMLTextAreaElement>
  ) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const title = quickAddValue.trim();
      if (!title || isSubmitting) return;
      setIsSubmitting(true);
      try {
        await onCreateTask(title);
        setQuickAddValue("");
        setIsExpanded(false);
      } finally {
        setIsSubmitting(false);
      }
    }
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
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <span style={{ fontWeight: 600, fontSize: "14px", color: "#1e293b" }}>
          Tasks
          <span
            style={{
              marginLeft: "8px",
              fontSize: "12px",
              fontWeight: 400,
              color: "#94a3b8",
            }}
          >
            ({tasks.length})
          </span>
        </span>

        {groups && onSelectGroup && onCreateGroup && (
          <GroupSelector
            groups={groups}
            activeGroupId={activeGroupId ?? null}
            onSelectGroup={onSelectGroup}
            onCreateGroup={onCreateGroup}
          />
        )}
      </div>

      {savedViews.length > 0 && (
        <div style={{ flexShrink: 0 }}>
          <ViewPicker
            views={savedViews}
            activeViewId={activeView?.viewId ?? ""}
            onSelect={handleViewSelect}
          />
        </div>
      )}

      <div style={{ flex: 1, overflowY: "auto" }}>
        {tasks.length === 0 ? (
          <p
            style={{
              color: "#94a3b8",
              fontSize: "14px",
              textAlign: "center",
              marginTop: "32px",
              padding: "0 16px",
            }}
          >
            No tasks yet. Create one below.
          </p>
        ) : (
          tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              isSelected={task.id === selectedTaskId}
              onClick={() => {}}
            />
          ))
        )}
      </div>

      <div
        style={{
          padding: "12px 16px",
          borderTop: "1px solid #e2e8f0",
          flexShrink: 0,
        }}
      >
        <textarea
          ref={textareaRef}
          value={quickAddValue}
          onChange={(e) => setQuickAddValue(e.target.value)}
          onFocus={() => setIsExpanded(true)}
          onBlur={() => {
            if (!quickAddValue) setIsExpanded(false);
          }}
          onKeyDown={handleQuickAddKeyDown}
          placeholder="Add a task... (Enter to create)"
          disabled={isSubmitting}
          rows={isExpanded ? 3 : 1}
          style={{
            width: "100%",
            resize: "none",
            borderRadius: "8px",
            border: "1px solid #e2e8f0",
            padding: "8px 12px",
            fontSize: "14px",
            lineHeight: "1.5",
            outline: "none",
            fontFamily: "inherit",
            backgroundColor: isSubmitting ? "#f8fafc" : "#ffffff",
            color: "#1e293b",
            boxSizing: "border-box",
            transition: "height 0.15s",
          }}
        />
        {isExpanded && (
          <p
            style={{
              margin: "4px 0 0",
              fontSize: "11px",
              color: "#94a3b8",
            }}
          >
            Press Enter to create
          </p>
        )}
      </div>
    </div>
  );
}
