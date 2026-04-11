import React, { useState } from "react";
import type { TaskComment } from "@tasks/tasks-lib";

interface CommentThreadProps {
  comments: TaskComment[];
  onAddComment: (content: string) => void;
}

export function CommentThread({ comments, onAddComment }: CommentThreadProps) {
  const [inputValue, setInputValue] = useState("");

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleSubmit = () => {
    const content = inputValue.trim();
    if (!content) return;
    onAddComment(content);
    setInputValue("");
  };

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
        Comments
      </h3>

      <div style={{ marginBottom: "16px" }}>
        {comments.length === 0 ? (
          <p style={{ fontSize: "13px", color: "#94a3b8" }}>No comments yet.</p>
        ) : (
          comments.map((comment) => (
            <div
              key={comment.commentId}
              style={{
                marginBottom: "12px",
                padding: "10px 12px",
                backgroundColor: "#f8fafc",
                borderRadius: "8px",
                border: "1px solid #e2e8f0",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: "6px",
                }}
              >
                <span
                  style={{
                    fontSize: "12px",
                    fontWeight: 600,
                    color: "#475569",
                  }}
                >
                  {comment.author}
                </span>
                <span style={{ fontSize: "11px", color: "#94a3b8" }}>
                  {new Date(comment.timestamp).toLocaleString()}
                </span>
              </div>
              <p
                style={{
                  margin: 0,
                  fontSize: "13px",
                  color: "#1e293b",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  lineHeight: "1.5",
                }}
              >
                {comment.content}
              </p>
            </div>
          ))
        )}
      </div>

      <div>
        <textarea
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Add a comment... (Enter to submit, Shift+Enter for newline)"
          rows={2}
          style={{
            width: "100%",
            resize: "none",
            borderRadius: "8px",
            border: "1px solid #e2e8f0",
            padding: "8px 12px",
            fontSize: "13px",
            lineHeight: "1.5",
            outline: "none",
            fontFamily: "inherit",
            color: "#1e293b",
            boxSizing: "border-box",
          }}
        />
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "6px" }}>
          <button
            onClick={handleSubmit}
            disabled={!inputValue.trim()}
            style={{
              padding: "6px 14px",
              borderRadius: "6px",
              border: "none",
              backgroundColor: !inputValue.trim() ? "#cbd5e1" : "#3b82f6",
              color: "#ffffff",
              fontSize: "13px",
              fontWeight: 500,
              cursor: !inputValue.trim() ? "not-allowed" : "pointer",
            }}
          >
            Comment
          </button>
        </div>
      </div>
    </div>
  );
}
