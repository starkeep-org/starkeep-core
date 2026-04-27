import React, { useState, useRef, useEffect } from "react";
import type { AppImage, CropRect } from "@photos/photos-lib";
import { CaptionEditor } from "./caption-editor.js";
import { PhotoInfoPanel } from "./photo-info-panel.js";
import { CropTool } from "./crop-tool.js";
import { usePhotoUrls } from "../../context/photo-url-context.js";

const ORIENTATION_TRANSFORMS: Record<number, string> = {
  3: "rotate(180deg)",
  6: "rotate(90deg)",
  8: "rotate(270deg)",
};

interface PhotoViewerProps {
  image: AppImage;
  onClose: () => void;
  onUpdateCaption: (caption: string) => Promise<void>;
  onCrop: (cropRect: CropRect) => Promise<void>;
  onShare: () => Promise<{ token: string; shareUrl: string } | null>;
}

export function PhotoViewer({ image, onClose, onUpdateCaption, onCrop, onShare }: PhotoViewerProps) {
  const { getFullSizeSrc } = usePhotoUrls();
  const [infoVisible, setInfoVisible] = useState(false);
  const [cropMode, setCropMode] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (cropMode) setCropMode(false);
        else onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [cropMode, onClose]);

  const transform =
    image.exif.orientation
      ? (ORIENTATION_TRANSFORMS[image.exif.orientation] ?? "none")
      : "none";

  const handleShare = async () => {
    const result = await onShare();
    if (result) setShareUrl(result.shareUrl);
  };

  const handleImgLoad = () => {
    const el = imgRef.current;
    if (el) setImgSize({ w: el.offsetWidth, h: el.offsetHeight });
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.92)",
        zIndex: 1000,
        display: "flex",
        flexDirection: "column",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !cropMode) onClose();
      }}
    >
      {/* Top bar */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "12px 16px",
          flexShrink: 0,
        }}
      >
        <span style={{ color: "#aaa", fontSize: 14 }}>{image.title || image.originalFilename}</span>
        <button
          onClick={onClose}
          style={{
            background: "none",
            border: "none",
            color: "#fff",
            fontSize: 24,
            cursor: "pointer",
            lineHeight: 1,
            padding: "0 4px",
          }}
        >
          ×
        </button>
      </div>

      {/* Image area */}
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          position: "relative",
          overflow: "hidden",
        }}
      >
        <div style={{ position: "relative" }}>
          <img
            ref={imgRef}
            src={getFullSizeSrc(image.id) ?? undefined}
            alt={image.title || image.originalFilename}
            onLoad={handleImgLoad}
            style={{
              maxWidth: "90vw",
              maxHeight: "calc(100vh - 200px)",
              objectFit: "contain",
              transform,
              display: "block",
            }}
          />
          {cropMode && imgSize && (
            <CropTool
              displayWidth={imgSize.w}
              displayHeight={imgSize.h}
              originalWidth={image.width}
              originalHeight={image.height}
              onApply={async (cropRect) => {
                await onCrop(cropRect);
                setCropMode(false);
              }}
              onCancel={() => setCropMode(false)}
            />
          )}
        </div>

        {/* Info panel */}
        <PhotoInfoPanel
          image={image}
          visible={infoVisible}
          onClose={() => setInfoVisible(false)}
        />
      </div>

      {/* Bottom area */}
      <div
        style={{
          padding: "12px 16px",
          flexShrink: 0,
          maxWidth: 600,
          margin: "0 auto",
          width: "100%",
        }}
      >
        <CaptionEditor caption={image.caption} onSave={onUpdateCaption} />

        <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
          <ToolbarButton onClick={() => setInfoVisible(!infoVisible)} active={infoVisible}>
            Info
          </ToolbarButton>
          <ToolbarButton onClick={() => { setCropMode(!cropMode); setInfoVisible(false); }} active={cropMode}>
            Crop
          </ToolbarButton>
          <ToolbarButton onClick={handleShare}>Share</ToolbarButton>
        </div>

        {shareUrl && (
          <div
            style={{
              marginTop: 8,
              padding: "8px 12px",
              background: "rgba(255,255,255,0.1)",
              borderRadius: 4,
              fontSize: 12,
              color: "#aaa",
              display: "flex",
              gap: 8,
              alignItems: "center",
            }}
          >
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {window.location.origin}{shareUrl}
            </span>
            <button
              onClick={() => void navigator.clipboard.writeText(`${window.location.origin}${shareUrl}`)}
              style={{
                background: "rgba(255,255,255,0.2)",
                border: "none",
                color: "#fff",
                borderRadius: 3,
                padding: "2px 8px",
                cursor: "pointer",
                fontSize: 11,
                flexShrink: 0,
              }}
            >
              Copy
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function ToolbarButton({
  onClick,
  active,
  children,
}: {
  onClick: () => void;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        background: active ? "rgba(255,255,255,0.2)" : "rgba(255,255,255,0.1)",
        border: "1px solid rgba(255,255,255,0.2)",
        color: "#fff",
        borderRadius: 4,
        padding: "6px 14px",
        cursor: "pointer",
        fontSize: 13,
      }}
    >
      {children}
    </button>
  );
}
