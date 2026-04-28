import React, { useState, useEffect } from "react";
import type { AppImage } from "@/photos-lib";

interface SharedPhotoPageProps {
  token: string;
}

export function SharedPhotoPage({ token }: SharedPhotoPageProps) {
  const [image, setImage] = useState<AppImage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/shared/${token}`)
      .then((r) => r.json())
      .then((data: { image?: AppImage; error?: string }) => {
        if (data.error) setError(data.error);
        else if (data.image) setImage(data.image);
      })
      .catch(() => setError("Failed to load photo"))
      .finally(() => setLoading(false));
  }, [token]);

  if (loading) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", background: "#111", color: "#888" }}>
        Loading...
      </div>
    );
  }

  if (error || !image) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", background: "#111", color: "#666", flexDirection: "column", gap: 8 }}>
        <div style={{ fontSize: 18 }}>Photo not found</div>
        <div style={{ fontSize: 13 }}>{error ?? "This link may have expired or been revoked."}</div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: "#111", display: "flex", flexDirection: "column", alignItems: "center" }}>
      <div style={{ maxWidth: 960, width: "100%", padding: "32px 16px" }}>
        <img
          src={`/api/photos/${image.id}/thumbnail`}
          alt={image.title || image.originalFilename}
          style={{ width: "100%", maxHeight: "70vh", objectFit: "contain", borderRadius: 4 }}
        />

        <div style={{ marginTop: 16 }}>
          {image.title && (
            <div style={{ color: "#fff", fontSize: 20, fontWeight: 600, marginBottom: 8 }}>
              {image.title}
            </div>
          )}
          {image.caption && (
            <div style={{ color: "#bbb", fontSize: 15, marginBottom: 12 }}>
              {image.caption}
            </div>
          )}
          <div style={{ color: "#666", fontSize: 13 }}>
            {image.effectiveDateTaken.slice(0, 10)}
            {image.exif.cameraMake && ` · ${image.exif.cameraMake} ${image.exif.cameraModel ?? ""}`.trimEnd()}
          </div>
        </div>

        <div style={{ marginTop: 32, color: "#444", fontSize: 12 }}>
          Shared via Starkeep Photos
        </div>
      </div>
    </div>
  );
}
