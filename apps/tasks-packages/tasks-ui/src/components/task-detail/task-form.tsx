import React, { useEffect, useRef, useState } from "react";
import type { Task, TdoFileContent, TaskStatus, Blocker } from "@tasks/tasks-lib";

const TASK_STATUSES: TaskStatus[] = [
  "Backlog",
  "Todo",
  "In Progress",
  "Blocked",
  "Done",
];

interface TaskFormProps {
  task: Task;
  onUpdate: (updates: Partial<TdoFileContent>) => void;
}

export function TaskForm({ task, onUpdate }: TaskFormProps) {
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [assignee, setAssignee] = useState(task.assignee ?? "");
  const [labelInput, setLabelInput] = useState("");
  const [blockerTaskIdInput, setBlockerTaskIdInput] = useState("");
  const [blockerDescInput, setBlockerDescInput] = useState("");

  const descRef = useRef<HTMLTextAreaElement>(null);

  // Sync external task updates into local state
  useEffect(() => {
    setTitle(task.title);
    setDescription(task.description);
    setAssignee(task.assignee ?? "");
  }, [task.id]);

  const autoResizeTextarea = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };

  const handleTitleBlur = () => {
    if (title !== task.title) {
      onUpdate({ title });
    }
  };

  const handleDescriptionBlur = () => {
    if (description !== task.description) {
      onUpdate({ description });
    }
  };

  const handleAssigneeBlur = () => {
    const newAssignee = assignee.trim() || null;
    if (newAssignee !== task.assignee) {
      onUpdate({ assignee: newAssignee });
    }
  };

  const handleStatusChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    onUpdate({ status: e.target.value as TaskStatus });
  };

  const handleAddLabel = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const label = labelInput.trim();
      if (!label || task.labels.includes(label)) return;
      onUpdate({ labels: [...task.labels, label] });
      setLabelInput("");
    }
  };

  const handleRemoveLabel = (label: string) => {
    onUpdate({ labels: task.labels.filter((l) => l !== label) });
  };

  const handleAddTaskBlocker = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const taskId = blockerTaskIdInput.trim();
      if (!taskId) return;
      const blocker: Blocker = { type: "task", taskId };
      onUpdate({ blockers: [...task.blockers, blocker] });
      setBlockerTaskIdInput("");
    }
  };

  const handleAddExternalBlocker = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const description = blockerDescInput.trim();
      if (!description) return;
      const blocker: Blocker = { type: "external", description };
      onUpdate({ blockers: [...task.blockers, blocker] });
      setBlockerDescInput("");
    }
  };

  const handleRemoveBlocker = (index: number) => {
    onUpdate({ blockers: task.blockers.filter((_, i) => i !== index) });
  };

  const fieldLabelStyle: React.CSSProperties = {
    fontSize: "11px",
    fontWeight: 600,
    color: "#64748b",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    display: "block",
    marginBottom: "4px",
  };

  const inputStyle: React.CSSProperties = {
    width: "100%",
    borderRadius: "6px",
    border: "1px solid #e2e8f0",
    padding: "6px 10px",
    fontSize: "13px",
    lineHeight: "1.5",
    outline: "none",
    fontFamily: "inherit",
    color: "#1e293b",
    boxSizing: "border-box",
    backgroundColor: "#ffffff",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      {/* Title */}
      <div>
        <label style={fieldLabelStyle}>Title</label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={handleTitleBlur}
          style={inputStyle}
        />
      </div>

      {/* Status */}
      <div>
        <label style={fieldLabelStyle}>Status</label>
        <select
          value={task.status}
          onChange={handleStatusChange}
          style={{ ...inputStyle, cursor: "pointer" }}
        >
          {TASK_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      {/* Assignee */}
      <div>
        <label style={fieldLabelStyle}>Assignee</label>
        <input
          type="text"
          value={assignee}
          onChange={(e) => setAssignee(e.target.value)}
          onBlur={handleAssigneeBlur}
          placeholder="Unassigned"
          style={inputStyle}
        />
      </div>

      {/* Description */}
      <div>
        <label style={fieldLabelStyle}>Description</label>
        <textarea
          ref={descRef}
          value={description}
          onChange={(e) => {
            setDescription(e.target.value);
            autoResizeTextarea(e.target);
          }}
          onBlur={handleDescriptionBlur}
          placeholder="Add a description..."
          rows={3}
          style={{
            ...inputStyle,
            resize: "none",
            overflow: "hidden",
          }}
        />
      </div>

      {/* Labels */}
      <div>
        <label style={fieldLabelStyle}>Labels</label>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "4px", marginBottom: "6px" }}>
          {task.labels.map((label) => (
            <span
              key={label}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "4px",
                fontSize: "12px",
                padding: "2px 8px",
                borderRadius: "999px",
                backgroundColor: "#eff6ff",
                color: "#3b82f6",
                border: "1px solid #bfdbfe",
              }}
            >
              {label}
              <button
                onClick={() => handleRemoveLabel(label)}
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  padding: "0",
                  color: "#93c5fd",
                  fontSize: "14px",
                  lineHeight: "1",
                  display: "flex",
                  alignItems: "center",
                }}
                aria-label={`Remove label ${label}`}
              >
                &#215;
              </button>
            </span>
          ))}
        </div>
        <input
          type="text"
          value={labelInput}
          onChange={(e) => setLabelInput(e.target.value)}
          onKeyDown={handleAddLabel}
          placeholder="Type a label and press Enter"
          style={inputStyle}
        />
      </div>

      {/* Blockers */}
      <div>
        <label style={fieldLabelStyle}>Blockers</label>
        {task.blockers.length > 0 && (
          <div style={{ marginBottom: "8px", display: "flex", flexDirection: "column", gap: "4px" }}>
            {task.blockers.map((blocker, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "6px 10px",
                  borderRadius: "6px",
                  backgroundColor: "#fff7ed",
                  border: "1px solid #fed7aa",
                  fontSize: "12px",
                  color: "#c2410c",
                }}
              >
                <span>
                  {blocker.type === "task"
                    ? `Task: ${blocker.taskId}`
                    : `External: ${blocker.description}`}
                </span>
                <button
                  onClick={() => handleRemoveBlocker(i)}
                  style={{
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    color: "#f97316",
                    fontSize: "14px",
                    lineHeight: "1",
                    display: "flex",
                    alignItems: "center",
                    padding: "0",
                  }}
                  aria-label="Remove blocker"
                >
                  &#215;
                </button>
              </div>
            ))}
          </div>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          <input
            type="text"
            value={blockerTaskIdInput}
            onChange={(e) => setBlockerTaskIdInput(e.target.value)}
            onKeyDown={handleAddTaskBlocker}
            placeholder="Blocked by task ID (press Enter to add)"
            style={inputStyle}
          />
          <input
            type="text"
            value={blockerDescInput}
            onChange={(e) => setBlockerDescInput(e.target.value)}
            onKeyDown={handleAddExternalBlocker}
            placeholder="External blocker description (press Enter to add)"
            style={inputStyle}
          />
        </div>
      </div>
    </div>
  );
}
