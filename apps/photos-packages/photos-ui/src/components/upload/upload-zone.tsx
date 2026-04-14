import React, { useState, useRef } from "react";

interface UploadZoneProps {
  onUpload: (file: File) => Promise<void>;
  uploading: boolean;
}

export function UploadZone({ onUpload, uploading }: UploadZoneProps) {
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFiles = async (files: FileList | null) => {
    if (!files || uploading) return;
    for (const file of Array.from(files)) {
      if (file.type.startsWith("image/")) {
        await onUpload(file);
      }
    }
  };

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => { e.preventDefault(); setDragOver(false); void handleFiles(e.dataTransfer.files); }}
      onClick={() => !uploading && inputRef.current?.click()}
      style={{
        border: `2px dashed ${dragOver ? "rgba(255,255,255,0.6)" : "rgba(255,255,255,0.2)"}`,
        borderRadius: 8,
        padding: "24px 32px",
        textAlign: "center",
        cursor: uploading ? "not-allowed" : "pointer",
        color: "#888",
        fontSize: 14,
        transition: "border-color 0.15s, background 0.15s",
        background: dragOver ? "rgba(255,255,255,0.05)" : "transparent",
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        style={{ display: "none" }}
        onChange={(e) => void handleFiles(e.target.files)}
      />
      {uploading ? "Uploading..." : "Drop photos here or click to select"}
    </div>
  );
}
