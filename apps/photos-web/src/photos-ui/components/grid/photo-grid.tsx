import React, { useEffect, useRef } from "react";
import type { AppImage } from "@/photos-lib";
import { DateSection } from "./date-section";

interface PhotoGridProps {
  images: AppImage[];
  loading: boolean;
  hasMore: boolean;
  onSelect: (id: string) => void;
  onLoadMore: () => void;
}

export function PhotoGrid({ images, loading, hasMore, onSelect, onLoadMore }: PhotoGridProps) {
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !loading) {
          onLoadMore();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loading, onLoadMore]);

  // Group by date descending
  const grouped: Record<string, AppImage[]> = {};
  for (const img of images) {
    const day = img.effectiveDateTaken.slice(0, 10);
    (grouped[day] ??= []).push(img);
  }
  const sortedDays = Object.keys(grouped).sort().reverse();

  if (images.length === 0 && !loading) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100%",
          color: "#666",
          fontSize: 16,
        }}
      >
        No photos yet. Upload some to get started.
      </div>
    );
  }

  return (
    <div style={{ paddingTop: 16, paddingBottom: 32 }}>
      {sortedDays.map((day) => (
        <DateSection key={day} dateKey={day} images={grouped[day]} onSelect={onSelect} />
      ))}
      <div ref={sentinelRef} style={{ height: 1 }} />
      {loading && (
        <div style={{ textAlign: "center", color: "#666", padding: 16 }}>Loading...</div>
      )}
    </div>
  );
}
