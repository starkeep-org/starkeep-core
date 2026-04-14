import React, { useState, useEffect, useRef, useCallback } from "react";
import type { StarkeepSdk } from "@starkeep/sdk";
import type { AppImage, CropRect } from "@photos/photos-lib";
import {
  PhotoProvider,
  PhotoUrlProvider,
  PhotoGrid,
  PhotoViewer,
  UploadZone,
  GoogleImportPanel,
  usePhotoContext,
} from "@photos/photos-ui";
import { getSdk, generateImageMetadata, cropImageBytesCanvas, apiRequest } from "./lib/sdk.js";

// ---------------------------------------------------------------------------
// Blob URL cache for thumbnails — triggers re-renders when URLs become ready
// ---------------------------------------------------------------------------

function useThumbnailCache(sdk: StarkeepSdk | null, userId: string) {
  const [urlMap, setUrlMap] = useState<ReadonlyMap<string, string>>(new Map());
  const loadingRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    return () => {
      for (const url of urlMap.values()) URL.revokeObjectURL(url);
    };
  }, []); // intentionally only on unmount

  const getThumbnailSrc = useCallback(
    (imageId: string): string => {
      const cached = urlMap.get(imageId);
      if (cached) return cached;
      if (!sdk || loadingRef.current.has(imageId)) return "";

      loadingRef.current.add(imageId);
      apiRequest<{ thumbnailBase64: string; contentType: string }>(
        sdk,
        "photos:v1/photos/thumbnail",
        "GET",
        userId,
        { query: { id: imageId } },
      )
        .then(({ thumbnailBase64, contentType }) => {
          const byteString = atob(thumbnailBase64);
          const bytes = new Uint8Array(byteString.length);
          for (let i = 0; i < byteString.length; i++) bytes[i] = byteString.charCodeAt(i);
          const blob = new Blob([bytes], { type: contentType });
          const blobUrl = URL.createObjectURL(blob);
          loadingRef.current.delete(imageId);
          setUrlMap((prev) => new Map(prev).set(imageId, blobUrl));
        })
        .catch(() => {
          loadingRef.current.delete(imageId);
        });

      return "";
    },
    [sdk, userId, urlMap],
  );

  return getThumbnailSrc;
}

// ---------------------------------------------------------------------------
// Inner app (has access to PhotoProvider state)
// ---------------------------------------------------------------------------

function PhotosAppDesktopInner({ sdk, userId }: { sdk: StarkeepSdk; userId: string }) {
  const { state, dispatch } = usePhotoContext();
  const [uploading, setUploading] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [showGoogleImport, setShowGoogleImport] = useState(false);

  const selectedImage = state.selectedId
    ? state.images.find((img) => img.id === state.selectedId) ?? null
    : null;

  const loadPhotos = useCallback(
    async (cursor?: string) => {
      dispatch({ type: "SET_LOADING", loading: true });
      try {
        const query: Record<string, string> = {};
        if (cursor) query.cursor = cursor;
        const data = await apiRequest<{ images: AppImage[]; nextCursor: string | null }>(
          sdk,
          "photos:v1/photos/list",
          "GET",
          userId,
          { query },
        );
        if (cursor) {
          dispatch({ type: "APPEND_IMAGES", images: data.images });
        } else {
          dispatch({ type: "SET_IMAGES", images: data.images });
        }
        dispatch({ type: "SET_NEXT_CURSOR", cursor: data.nextCursor });
      } finally {
        dispatch({ type: "SET_LOADING", loading: false });
      }
    },
    [sdk, userId, dispatch],
  );

  useEffect(() => {
    void loadPhotos();
  }, [loadPhotos]);

  const handleUpload = async (file: File) => {
    setUploading(true);
    try {
      const arrayBuffer = await file.arrayBuffer();
      const fileBase64 = btoa(
        String.fromCharCode(...new Uint8Array(arrayBuffer)),
      );
      const result = await apiRequest<{ imageId: string }>(
        sdk,
        "photos:v1/photos/upload",
        "POST",
        userId,
        {
          body: {
            fileBase64,
            mimeType: file.type,
            provenance: { originalFilename: file.name, googlePhotosId: null, sourceImageId: null },
            userAuthored: {
              title: file.name.replace(/\.[^.]+$/, ""),
              caption: "",
              dateTakenOverride: null,
            },
          },
        },
      );
      await generateImageMetadata(sdk, result.imageId);
      const imageData = await apiRequest<{ image: AppImage }>(
        sdk,
        "photos:v1/photos/item",
        "GET",
        userId,
        { query: { id: result.imageId } },
      );
      dispatch({ type: "APPEND_IMAGES", images: [imageData.image] });
    } finally {
      setUploading(false);
    }
  };

  const handleUpdateCaption = async (caption: string) => {
    if (!selectedImage) return;
    const data = await apiRequest<{ image: AppImage }>(
      sdk,
      "photos:v1/photos/item",
      "PATCH",
      userId,
      { body: { id: selectedImage.id, caption } },
    );
    dispatch({ type: "OPTIMISTIC_UPDATE", image: data.image });
  };

  const handleCrop = async (cropRect: CropRect) => {
    if (!selectedImage) return;
    // Inject the Canvas-based crop function — the handler calls it to produce cropped bytes.
    const result = await apiRequest<{ imageId: string }>(
      sdk,
      "photos:v1/photos/crop",
      "POST",
      userId,
      {
        body: {
          sourceImageId: selectedImage.id,
          cropRect,
          cropImageBytes: (bytes: Uint8Array, x: number, y: number, w: number, h: number) =>
            cropImageBytesCanvas(bytes, x, y, w, h),
        },
      },
    );
    await generateImageMetadata(sdk, result.imageId);
    const imageData = await apiRequest<{ image: AppImage }>(
      sdk,
      "photos:v1/photos/item",
      "GET",
      userId,
      { query: { id: result.imageId } },
    );
    dispatch({ type: "APPEND_IMAGES", images: [imageData.image] });
    dispatch({ type: "SET_SELECTED_ID", id: imageData.image.id });
  };

  const handleShare = async () => {
    if (!selectedImage) return null;
    return apiRequest<{ token: string; shareUrl: string }>(
      sdk,
      "photos:v1/photos/share",
      "POST",
      userId,
      { body: { imageId: selectedImage.id } },
    );
  };

  // Thumbnail blob URLs via SDK
  const getThumbnailSrc = useThumbnailCache(sdk, userId);

  return (
    <PhotoUrlProvider getThumbnailSrc={getThumbnailSrc}>
      <div
        style={{
          minHeight: "100vh",
          background: "#111",
          color: "#fff",
          fontFamily: "sans-serif",
        }}
      >
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

        {showUpload && (
          <div style={{ padding: "12px 20px", borderBottom: "1px solid rgba(255,255,255,0.1)" }}>
            <UploadZone onUpload={handleUpload} uploading={uploading} />
          </div>
        )}

        <PhotoGrid
          images={state.images}
          loading={state.loading}
          hasMore={!!state.nextCursor}
          onLoadMore={() => { if (state.nextCursor) void loadPhotos(state.nextCursor); }}
          onSelect={(id) => dispatch({ type: "SET_SELECTED_ID", id })}
        />

        {selectedImage && (
          <PhotoViewer
            image={selectedImage}
            onClose={() => dispatch({ type: "SET_SELECTED_ID", id: null })}
            onUpdateCaption={handleUpdateCaption}
            onCrop={handleCrop}
            onShare={handleShare}
          />
        )}

        {showGoogleImport && (
          <GoogleImportPanel
            onImportComplete={(_count) => {
              void loadPhotos();
              setShowGoogleImport(false);
            }}
            onClose={() => setShowGoogleImport(false)}
          />
        )}
      </div>
    </PhotoUrlProvider>
  );
}

// ---------------------------------------------------------------------------
// SDK loader
// ---------------------------------------------------------------------------

function SdkLoader() {
  const [sdk, setSdk] = useState<StarkeepSdk | null>(null);
  const userId = "local-user";
  const nodeId = "desktop-node-1";

  useEffect(() => {
    getSdk({ ownerId: userId, nodeId })
      .then(setSdk)
      .catch((err) => console.error("[SdkLoader]", err));
  }, []);

  if (!sdk) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100vh",
          background: "#111",
          color: "#666",
          fontSize: 14,
        }}
      >
        Starting up...
      </div>
    );
  }

  return <PhotosAppDesktopInner sdk={sdk} userId={userId} />;
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

export function App() {
  return (
    <PhotoProvider>
      <SdkLoader />
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
