import React, { useState, useRef, useCallback } from "react";
import type { CropRect } from "@photos/photos-lib";

interface CropToolProps {
  displayWidth: number;
  displayHeight: number;
  originalWidth: number;
  originalHeight: number;
  onApply: (cropRect: CropRect) => void;
  onCancel: () => void;
}

interface DragState {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  isDragging: boolean;
}

export function CropTool({
  displayWidth,
  displayHeight,
  originalWidth,
  originalHeight,
  onApply,
  onCancel,
}: CropToolProps) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const getRelativePos = (e: React.MouseEvent) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: Math.max(0, Math.min(displayWidth, e.clientX - rect.left)),
      y: Math.max(0, Math.min(displayHeight, e.clientY - rect.top)),
    };
  };

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const { x, y } = getRelativePos(e);
    setDrag({ startX: x, startY: y, currentX: x, currentY: y, isDragging: true });
  }, []);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!drag?.isDragging) return;
      const { x, y } = getRelativePos(e);
      setDrag((d) => d ? { ...d, currentX: x, currentY: y } : null);
    },
    [drag?.isDragging],
  );

  const handleMouseUp = useCallback(() => {
    if (drag) setDrag((d) => d ? { ...d, isDragging: false } : null);
  }, [drag]);

  const getDisplayRect = () => {
    if (!drag) return null;
    const x = Math.min(drag.startX, drag.currentX);
    const y = Math.min(drag.startY, drag.currentY);
    const w = Math.abs(drag.currentX - drag.startX);
    const h = Math.abs(drag.currentY - drag.startY);
    return { x, y, w, h };
  };

  const handleApply = () => {
    const rect = getDisplayRect();
    if (!rect || rect.w < 10 || rect.h < 10) return;
    const scaleX = originalWidth / displayWidth;
    const scaleY = originalHeight / displayHeight;
    onApply({
      x: Math.round(rect.x * scaleX),
      y: Math.round(rect.y * scaleY),
      width: Math.round(rect.w * scaleX),
      height: Math.round(rect.h * scaleY),
    });
  };

  const rect = getDisplayRect();

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        cursor: "crosshair",
        userSelect: "none",
      }}
      ref={containerRef}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
    >
      {/* Dark overlay */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: "rgba(0,0,0,0.5)",
          pointerEvents: "none",
        }}
      />

      {/* Selection rectangle */}
      {rect && rect.w > 0 && rect.h > 0 && (
        <>
          {/* Clear window over selection */}
          <div
            style={{
              position: "absolute",
              left: rect.x,
              top: rect.y,
              width: rect.w,
              height: rect.h,
              boxShadow: "0 0 0 9999px rgba(0,0,0,0.5)",
              border: "2px dashed rgba(255,255,255,0.8)",
              pointerEvents: "none",
              background: "transparent",
            }}
          />
        </>
      )}

      {/* Controls */}
      <div
        style={{
          position: "absolute",
          bottom: -48,
          left: "50%",
          transform: "translateX(-50%)",
          display: "flex",
          gap: 8,
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button
          onClick={handleApply}
          disabled={!rect || rect.w < 10 || rect.h < 10}
          style={{
            background: "#fff",
            color: "#000",
            border: "none",
            borderRadius: 4,
            padding: "6px 16px",
            cursor: "pointer",
            fontWeight: 600,
            fontSize: 13,
            opacity: rect && rect.w >= 10 ? 1 : 0.4,
          }}
        >
          Apply Crop
        </button>
        <button
          onClick={onCancel}
          style={{
            background: "rgba(255,255,255,0.15)",
            color: "#fff",
            border: "1px solid rgba(255,255,255,0.3)",
            borderRadius: 4,
            padding: "6px 16px",
            cursor: "pointer",
            fontSize: 13,
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
