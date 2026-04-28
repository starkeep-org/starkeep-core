import React, { useState, useEffect } from "react";
import type { AppImage, CropRect } from "@/photos-lib";
import { PhotoViewer } from "./components/viewer/photo-viewer";

interface PhotoViewerPageProps {
  imageId: string;
  onClose?: () => void;
}

export function PhotoViewerPage({ imageId, onClose }: PhotoViewerPageProps) {
  const [image, setImage] = useState<AppImage | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/photos/${imageId}`)
      .then((r) => r.json())
      .then((data: { image: AppImage }) => setImage(data.image))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [imageId]);

  const handleClose = () => {
    if (onClose) {
      onClose();
    } else {
      window.history.back();
    }
  };

  const handleUpdateCaption = async (caption: string) => {
    const res = await fetch(`/api/photos/${imageId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ caption }),
    });
    if (res.ok) {
      const data = (await res.json()) as { image: AppImage };
      setImage(data.image);
    }
  };

  const handleCrop = async (cropRect: CropRect) => {
    const res = await fetch("/api/photos/crop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceImageId: imageId, cropRect }),
    });
    if (res.ok) {
      const data = (await res.json()) as { image: AppImage };
      window.location.href = `/photo/${data.image.id}`;
    }
  };

  const handleShare = async () => {
    const res = await fetch("/api/share", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageId }),
    });
    if (!res.ok) return null;
    return (await res.json()) as { token: string; shareUrl: string };
  };

  if (loading) {
    return (
      <div
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.92)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#666",
          fontSize: 14,
        }}
      >
        Loading...
      </div>
    );
  }

  if (!image) {
    return (
      <div
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.92)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#666",
          fontSize: 14,
        }}
      >
        Photo not found.{" "}
        <button
          onClick={handleClose}
          style={{ marginLeft: 8, color: "#fff", background: "none", border: "none", cursor: "pointer" }}
        >
          Go back
        </button>
      </div>
    );
  }

  return (
    <PhotoViewer
      image={image}
      onClose={handleClose}
      onUpdateCaption={handleUpdateCaption}
      onCrop={handleCrop}
      onShare={handleShare}
    />
  );
}
