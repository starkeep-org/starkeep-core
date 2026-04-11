import React, { useEffect, useRef, useState } from "react";
import type { ChatTransport } from "../../hooks/use-chat.js";
import { useChat } from "../../hooks/use-chat.js";
import { MessageItem } from "./message-item.js";

interface ChatPanelProps {
  transport: ChatTransport;
}

export function ChatPanel({ transport }: ChatPanelProps) {
  const { messages, isLoading, sendMessage } = useChat(transport);
  const [inputValue, setInputValue] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleSubmit = () => {
    const text = inputValue.trim();
    if (!text || isLoading) return;
    setInputValue("");
    void sendMessage(text);
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
        }}
      >
        Chat
      </div>

      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "16px",
        }}
      >
        {messages.length === 0 && (
          <p
            style={{
              color: "#94a3b8",
              fontSize: "14px",
              textAlign: "center",
              marginTop: "32px",
            }}
          >
            Start a conversation...
          </p>
        )}
        {messages.map((message, index) => (
          <MessageItem key={index} message={message} />
        ))}
        {isLoading && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "6px",
              color: "#64748b",
              fontSize: "13px",
              marginBottom: "12px",
            }}
          >
            <span
              style={{
                display: "inline-block",
                width: "6px",
                height: "6px",
                borderRadius: "50%",
                backgroundColor: "#94a3b8",
                animation: "pulse 1s infinite",
              }}
            />
            <span>Thinking...</span>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div
        style={{
          padding: "12px 16px",
          borderTop: "1px solid #e2e8f0",
        }}
      >
        <div
          style={{
            display: "flex",
            gap: "8px",
            alignItems: "flex-end",
          }}
        >
          <textarea
            ref={textareaRef}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a message... (Enter to send, Shift+Enter for newline)"
            disabled={isLoading}
            rows={2}
            style={{
              flex: 1,
              resize: "none",
              borderRadius: "8px",
              border: "1px solid #e2e8f0",
              padding: "8px 12px",
              fontSize: "14px",
              lineHeight: "1.5",
              outline: "none",
              fontFamily: "inherit",
              backgroundColor: isLoading ? "#f8fafc" : "#ffffff",
              color: "#1e293b",
            }}
          />
          <button
            onClick={handleSubmit}
            disabled={isLoading || !inputValue.trim()}
            style={{
              padding: "8px 16px",
              borderRadius: "8px",
              border: "none",
              backgroundColor:
                isLoading || !inputValue.trim() ? "#cbd5e1" : "#3b82f6",
              color: "#ffffff",
              fontSize: "14px",
              fontWeight: 500,
              cursor:
                isLoading || !inputValue.trim() ? "not-allowed" : "pointer",
            }}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
