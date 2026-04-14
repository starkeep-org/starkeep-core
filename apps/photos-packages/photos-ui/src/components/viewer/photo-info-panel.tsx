import React from "react";
import type { AppImage } from "@photos/photos-lib";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface InfoRowProps {
  label: string;
  value: string | number;
}

function InfoRow({ label, value }: InfoRowProps) {
  return (
    <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
      <span style={{ color: "#888", fontSize: 12, minWidth: 100, flexShrink: 0 }}>{label}</span>
      <span style={{ color: "#ddd", fontSize: 12 }}>{String(value)}</span>
    </div>
  );
}

interface PhotoInfoPanelProps {
  image: AppImage;
  visible: boolean;
  onClose: () => void;
}

export function PhotoInfoPanel({ image, visible, onClose }: PhotoInfoPanelProps) {
  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        right: 0,
        bottom: 0,
        width: 280,
        background: "rgba(20,20,20,0.95)",
        borderLeft: "1px solid rgba(255,255,255,0.1)",
        overflowY: "auto",
        padding: 16,
        transform: visible ? "translateX(0)" : "translateX(100%)",
        transition: "transform 0.2s ease",
        zIndex: 10,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
        <span style={{ color: "#fff", fontWeight: 600, fontSize: 14 }}>Photo Info</span>
        <button
          onClick={onClose}
          style={{
            background: "none",
            border: "none",
            color: "#888",
            cursor: "pointer",
            fontSize: 18,
            padding: 0,
          }}
        >
          ×
        </button>
      </div>

      <InfoRow label="Filename" value={image.originalFilename} />
      <InfoRow label="Dimensions" value={`${image.width} × ${image.height}px`} />
      <InfoRow label="Format" value={image.format} />
      <InfoRow label="File size" value={formatBytes(image.sizeBytes)} />
      <InfoRow label="Date taken" value={image.effectiveDateTaken.replace("T", " ").slice(0, 19)} />

      {image.exif.cameraMake && (
        <InfoRow label="Camera" value={`${image.exif.cameraMake} ${image.exif.cameraModel ?? ""}`.trim()} />
      )}
      {image.exif.fNumber != null && (
        <InfoRow label="Aperture" value={`f/${image.exif.fNumber}`} />
      )}
      {image.exif.exposureTime && (
        <InfoRow label="Exposure" value={image.exif.exposureTime} />
      )}
      {image.exif.iso != null && (
        <InfoRow label="ISO" value={image.exif.iso} />
      )}
      {image.exif.lensModel && (
        <InfoRow label="Lens" value={image.exif.lensModel} />
      )}
      {image.exif.gpsLat != null && image.exif.gpsLon != null && (
        <InfoRow
          label="Location"
          value={`${image.exif.gpsLat.toFixed(5)}, ${image.exif.gpsLon.toFixed(5)}`}
        />
      )}

      {image.sourceImageId && (
        <>
          <div style={{ borderTop: "1px solid rgba(255,255,255,0.1)", margin: "12px 0" }} />
          <InfoRow label="Crop of" value={image.sourceImageId} />
          {image.cropRect && (
            <InfoRow
              label="Crop rect"
              value={`${image.cropRect.x},${image.cropRect.y} ${image.cropRect.width}×${image.cropRect.height}`}
            />
          )}
        </>
      )}

      {image.googlePhotosId && (
        <>
          <div style={{ borderTop: "1px solid rgba(255,255,255,0.1)", margin: "12px 0" }} />
          <InfoRow label="Source" value="Google Photos" />
        </>
      )}
    </div>
  );
}
