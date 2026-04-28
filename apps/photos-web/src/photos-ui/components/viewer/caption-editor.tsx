import React, { useState, useRef, useEffect } from "react";

interface CaptionEditorProps {
  caption: string;
  onSave: (caption: string) => Promise<void>;
}

export function CaptionEditor({ caption, onSave }: CaptionEditorProps) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(caption);
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setValue(caption);
  }, [caption]);

  useEffect(() => {
    if (editing) textareaRef.current?.focus();
  }, [editing]);

  const handleSave = async () => {
    if (value === caption) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await onSave(value);
      setEditing(false);
    } catch {
      // Revert to original on error
      setValue(caption);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={handleSave}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void handleSave();
          }
          if (e.key === "Escape") {
            setValue(caption);
            setEditing(false);
          }
        }}
        disabled={saving}
        placeholder="Add a caption..."
        style={{
          background: "transparent",
          border: "1px solid rgba(255,255,255,0.3)",
          borderRadius: 4,
          color: "#fff",
          fontSize: 14,
          padding: "6px 8px",
          width: "100%",
          resize: "none",
          outline: "none",
          fontFamily: "inherit",
          minHeight: 60,
        }}
      />
    );
  }

  return (
    <div
      onClick={() => setEditing(true)}
      style={{
        color: caption ? "#ddd" : "#555",
        fontSize: 14,
        cursor: "text",
        padding: "4px 0",
        minHeight: 24,
        lineHeight: "1.5",
      }}
    >
      {caption || "+ Add caption"}
    </div>
  );
}
