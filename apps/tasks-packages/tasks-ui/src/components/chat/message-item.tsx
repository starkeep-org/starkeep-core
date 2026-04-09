import React from "react";
import ReactMarkdown from "react-markdown";
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
        {isUser ? (
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
        ) : (
          <div
            style={{
              fontSize: "14px",
              lineHeight: "1.5",
              wordBreak: "break-word",
            }}
            className="markdown-content"
          >
            <ReactMarkdown
              components={{
                p: ({ children }) => (
                  <p style={{ margin: "0 0 8px 0" }}>{children}</p>
                ),
                ul: ({ children }) => (
                  <ul style={{ margin: "0 0 8px 0", paddingLeft: "20px" }}>{children}</ul>
                ),
                ol: ({ children }) => (
                  <ol style={{ margin: "0 0 8px 0", paddingLeft: "20px" }}>{children}</ol>
                ),
                li: ({ children }) => (
                  <li style={{ marginBottom: "2px" }}>{children}</li>
                ),
                code: ({ children, className }) => {
                  const isBlock = className?.includes("language-");
                  return isBlock ? (
                    <code
                      style={{
                        display: "block",
                        backgroundColor: "#e2e8f0",
                        borderRadius: "4px",
                        padding: "8px",
                        fontSize: "13px",
                        overflowX: "auto",
                        marginBottom: "8px",
                        whiteSpace: "pre",
                      }}
                    >
                      {children}
                    </code>
                  ) : (
                    <code
                      style={{
                        backgroundColor: "#e2e8f0",
                        borderRadius: "3px",
                        padding: "1px 4px",
                        fontSize: "13px",
                      }}
                    >
                      {children}
                    </code>
                  );
                },
                pre: ({ children }) => (
                  <pre style={{ margin: "0 0 8px 0", background: "none", padding: 0 }}>
                    {children}
                  </pre>
                ),
                strong: ({ children }) => (
                  <strong style={{ fontWeight: 600 }}>{children}</strong>
                ),
                h1: ({ children }) => (
                  <h1 style={{ fontSize: "16px", fontWeight: 700, margin: "0 0 8px 0" }}>{children}</h1>
                ),
                h2: ({ children }) => (
                  <h2 style={{ fontSize: "15px", fontWeight: 700, margin: "0 0 6px 0" }}>{children}</h2>
                ),
                h3: ({ children }) => (
                  <h3 style={{ fontSize: "14px", fontWeight: 700, margin: "0 0 4px 0" }}>{children}</h3>
                ),
              }}
            >
              {message.content}
            </ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
}
