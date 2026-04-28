import React, { useState } from "react";
import { PhotoProvider } from "./context/photo-context";
import { PhotoUrlProvider } from "./context/photo-url-context";
import { usePhotos } from "./hooks/use-photos";
import { PhotoGrid } from "./components/grid/photo-grid";
import { PhotoViewer } from "./components/viewer/photo-viewer";
import { UploadZone } from "./components/upload/upload-zone";
import { GoogleImportPanel } from "./components/google/google-import-panel";

function PhotosAppInner() {
  const {
    images,
    loading,
    nextCursor,
    loadMore,
    uploadPhoto,
    updatePhoto,
    cropPhoto,
    sharePhoto,
    selectImage,
    selectedId,
    fetchPhotos,
  } = usePhotos();

  const [uploading, setUploading] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [showGoogleImport, setShowGoogleImport] = useState(false);

  const selectedImage = selectedId ? images.find((img) => img.id === selectedId) ?? null : null;

  const handleUpload = async (file: File) => {
    setUploading(true);
    try {
      await uploadPhoto(file, file.name.replace(/\.[^.]+$/, ""), "");
    } finally {
      setUploading(false);
    }
  };

  const handleImportComplete = (_count: number) => {
    void fetchPhotos();
    setShowGoogleImport(false);
  };

  return (
    <div style={{ minHeight: "100vh", background: "#111", color: "#fff", fontFamily: "sans-serif" }}>
      {/* Toolbar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "12px 20px",
          borderBottom: "1px solid rgba(255,255,255,0.1)",
          position: "sticky",
          top: 0,
          background: "#111",
          zIndex: 100,
        }}
      >
        <span style={{ fontWeight: 700, fontSize: 17, letterSpacing: "-0.02em" }}>Photos</span>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={() => setShowGoogleImport(true)}
            style={toolbarButtonStyle}
          >
            Import from Google
          </button>
          <button
            onClick={() => setShowUpload(!showUpload)}
            style={{ ...toolbarButtonStyle, background: "rgba(255,255,255,0.15)" }}
          >
            Upload
          </button>
        </div>
      </div>

      {/* Upload zone */}
      {showUpload && (
        <div style={{ padding: "12px 20px", borderBottom: "1px solid rgba(255,255,255,0.1)" }}>
          <UploadZone onUpload={handleUpload} uploading={uploading} />
        </div>
      )}

      {/* Grid */}
      <PhotoGrid
        images={images}
        loading={loading}
        hasMore={!!nextCursor}
        onLoadMore={loadMore}
        onSelect={selectImage}
      />

      {/* Viewer overlay */}
      {selectedImage && (
        <PhotoViewer
          image={selectedImage}
          onClose={() => selectImage(null)}
          onUpdateCaption={async (caption) => {
            await updatePhoto(selectedImage.id, { caption });
          }}
          onCrop={async (cropRect) => {
            const newImage = await cropPhoto(selectedImage.id, cropRect);
            if (newImage) selectImage(newImage.id);
          }}
          onShare={async () => sharePhoto(selectedImage.id)}
        />
      )}

      {/* Google Import panel */}
      {showGoogleImport && (
        <GoogleImportPanel
          onImportComplete={handleImportComplete}
          onClose={() => setShowGoogleImport(false)}
        />
      )}
    </div>
  );
}

export function PhotosApp() {
  return (
    <PhotoProvider>
      <PhotoUrlProvider>
        <PhotosAppInner />
      </PhotoUrlProvider>
    </PhotoProvider>
  );
}

const toolbarButtonStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.08)",
  border: "1px solid rgba(255,255,255,0.15)",
  color: "#ddd",
  borderRadius: 4,
  padding: "6px 14px",
  cursor: "pointer",
  fontSize: 13,
};
