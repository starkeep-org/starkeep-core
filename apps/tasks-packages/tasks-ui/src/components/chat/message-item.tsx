import React from "react";
import type { DisplayMessage } from "@tasks/tasks-lib";

interface MessageItemProps {
  message: DisplayMessage;
}

export function MessageItem({ message }: MessageItemProps) {
  const isUser = message.role === "user";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: isUser ? "flex-end" : "flex-start",
        marginBottom: "12px",
      }}
    >
      <span
        style={{
          fontSize: "11px",
          fontWeight: 600,
          color: "#64748b",
          marginBottom: "4px",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
        }}
      >
        {isUser ? "You" : "Assistant"}
      </span>
      <div
        style={{
          maxWidth: "85%",
          backgroundColor: isUser ? "#3b82f6" : "#f1f5f9",
          color: isUser ? "#ffffff" : "#1e293b",
          borderRadius: isUser ? "12px 12px 2px 12px" : "12px 12px 12px 2px",
          padding: "8px 12px",
        }}
      >
        <p
          style={{
            margin: 0,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            fontSize: "14px",
            lineHeight: "1.5",
          }}
        >
          {message.content}
        </p>
      </div>
    </div>
  );
}
