import React from "react";
import type { AppImage } from "@/photos-lib";
import { PhotoThumbnail } from "./photo-thumbnail";

interface DateSectionProps {
  dateKey: string; // "YYYY-MM-DD"
  images: AppImage[];
  onSelect: (id: string) => void;
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

export function DateSection({ dateKey, images, onSelect }: DateSectionProps) {
  return (
    <div style={{ marginBottom: 32 }}>
      <div
        style={{
          color: "#ccc",
          fontSize: 14,
          fontWeight: 600,
          marginBottom: 8,
          padding: "0 16px",
        }}
      >
        {formatDate(dateKey)}
      </div>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 4,
          padding: "0 16px",
        }}
      >
        {images.map((img) => (
          <PhotoThumbnail key={img.id} image={img} onSelect={onSelect} />
        ))}
      </div>
    </div>
  );
}
