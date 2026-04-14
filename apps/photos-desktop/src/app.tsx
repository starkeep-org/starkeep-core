import React, { useState, useEffect, useRef, useCallback } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import type { AppImage } from "@photos/photos-lib";
import {
  PhotoProvider,
  PhotoUrlProvider,
  PhotoGrid,
  PhotoViewer,
  usePhotoContext,
} from "@photos/photos-ui";
import {
  addPhotoFromPath,
  listPhotos,
  getPhotoFileUrl,
  postMetadata,
  type PhotoRecord,
} from "./lib/data-server-client.js";

// ---------------------------------------------------------------------------
// Map a data-server PhotoRecord to the AppImage shape expected by the UI
// components. Metadata fields are filled with safe defaults; they will be
// enriched once the app-side generators run and their results are stored.
// ---------------------------------------------------------------------------

function photoRecordToAppImage(record: PhotoRecord): AppImage {
  return {
    id: record.id,
    mimeType: record.mime_type ?? "image/jpeg",
    objectStorageKey: record.object_storage_key ?? "",
    sizeBytes: record.size_bytes ?? 0,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    // Dimensions — populated after image-dimensions generator runs
    width: 0,
    height: 0,
    format: "unknown",
    // EXIF — populated after EXIF generator runs
    exif: {
      dateTakenRaw: null,
      cameraMake: null,
      cameraModel: null,
      fNumber: null,
      exposureTime: null,
      iso: null,
      lensModel: null,
      gpsLat: null,
      gpsLon: null,
      orientation: null,
    },
    // Provenance — set from payload on upload
    originalFilename: String(record.payload?.fileName ?? record.id),
    googlePhotosId: null,
    sourceImageId: null,
    cropRect: null,
    // User-authored — set from payload on upload
    caption: "",
    title: String(record.payload?.title ?? record.payload?.fileName ?? record.id),
    dateTakenOverride: null,
    // Thumbnail — not generated in PoC; full image is used directly
    thumbnailKey: null,
    thumbnailWidth: 0,
    thumbnailHeight: 0,
    // Effective date for sorting: fall back to record creation timestamp
    effectiveDateTaken: record.created_at,
  };
}

// ---------------------------------------------------------------------------
// File URL cache — fetches signed URLs from the data-server on demand and
// caches them so repeated renders don't re-request.
// ---------------------------------------------------------------------------

function useFileUrlCache() {
  const [urlMap, setUrlMap] = useState<ReadonlyMap<string, string>>(new Map());
  const loadingRef = useRef<Set<string>>(new Set());

  const getFileSrc = useCallback(
    (imageId: string): string => {
      const cached = urlMap.get(imageId);
      if (cached) return cached;
      if (loadingRef.current.has(imageId)) return "";

      loadingRef.current.add(imageId);
      getPhotoFileUrl(imageId)
        .then((url) => {
          loadingRef.current.delete(imageId);
          setUrlMap((prev) => new Map(prev).set(imageId, url));
        })
        .catch(() => {
          loadingRef.current.delete(imageId);
        });

      return "";
    },
    [urlMap],
  );

  return getFileSrc;
}

// ---------------------------------------------------------------------------
// Run app-side generators after a photo is added.
// Results are pushed to the data-server's /data/metadata endpoint so they
// land in the shared DB alongside the record.
// ---------------------------------------------------------------------------

async function runGenerators(
  record: PhotoRecord,
  fileBytes: Uint8Array,
  fileName: string,
  title: string,
): Promise<void> {
  const targetId = record.id;
  const targetType = "@starkeep/image";

  // Provenance — tracks original filename and source
  await postMetadata(targetId, targetType, "@photos/app:provenance", 1, {
    originalFilename: fileName,
    googlePhotosId: null,
    sourceImageId: null,
    cropX: null,
    cropY: null,
    cropWidth: null,
    cropHeight: null,
  });

  // User-authored — default title derived from filename; caption empty
  await postMetadata(targetId, targetType, "@photos/app:user-authored", 1, {
    title,
    caption: "",
    dateTakenOverride: null,
  });

  // EXIF — parse from raw bytes using exifr (no SDK context needed)
  try {
    const { default: Exifr } = await import("exifr");
    const exif = await Exifr.parse(fileBytes, {
      pick: ["DateTimeOriginal", "Make", "Model", "FNumber", "ExposureTime", "ISO", "LensModel",
             "GPSLatitude", "GPSLongitude", "Orientation"],
    }) as Record<string, unknown> | undefined;

    if (exif) {
      const dateTakenRaw = exif["DateTimeOriginal"]
        ? new Date(exif["DateTimeOriginal"] as string).toISOString()
        : null;
      await postMetadata(targetId, targetType, "@photos/app:exif", 1, {
        dateTakenRaw,
        cameraMake: (exif["Make"] as string) ?? null,
        cameraModel: (exif["Model"] as string) ?? null,
        fNumber: (exif["FNumber"] as number) ?? null,
        exposureTime: exif["ExposureTime"] != null ? String(exif["ExposureTime"]) : null,
        iso: (exif["ISO"] as number) ?? null,
        lensModel: (exif["LensModel"] as string) ?? null,
        gpsLat: (exif["GPSLatitude"] as number) ?? null,
        gpsLon: (exif["GPSLongitude"] as number) ?? null,
        orientation: (exif["Orientation"] as number) ?? null,
      });
    }
  } catch {
    // EXIF extraction is best-effort; skip if exifr fails or file has no EXIF
  }
}

// ---------------------------------------------------------------------------
// Inner app (has access to PhotoProvider state)
// ---------------------------------------------------------------------------

const IMAGE_EXTENSIONS: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
  gif: "image/gif", webp: "image/webp", heic: "image/heic",
  heif: "image/heif", avif: "image/avif", tiff: "image/tiff",
};

function PhotosAppDesktopInner() {
  const { state, dispatch } = usePhotoContext();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedImage = state.selectedId
    ? state.images.find((img) => img.id === state.selectedId) ?? null
    : null;

  const loadPhotos = useCallback(async () => {
    dispatch({ type: "SET_LOADING", loading: true });
    try {
      const records = await listPhotos();
      dispatch({ type: "SET_IMAGES", images: records.map(photoRecordToAppImage) });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load photos");
    } finally {
      dispatch({ type: "SET_LOADING", loading: false });
    }
  }, [dispatch]);

  useEffect(() => {
    void loadPhotos();
  }, [loadPhotos]);

  const handleAddClick = async () => {
    const selected = await open({
      multiple: false,
      filters: [{ name: "Images", extensions: Object.keys(IMAGE_EXTENSIONS) }],
    });
    if (!selected || typeof selected !== "string") return;

    setAdding(true);
    setError(null);
    try {
      const filePath = selected;
      const fileName = filePath.split("/").pop() ?? filePath;
      const title = fileName.replace(/\.[^.]+$/, "");
      const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
      const mimeType = IMAGE_EXTENSIONS[ext] ?? "application/octet-stream";

      const record = await addPhotoFromPath(filePath, mimeType, fileName, title);
      dispatch({ type: "APPEND_IMAGES", images: [photoRecordToAppImage(record)] });

      // Read bytes locally only for EXIF extraction (no bytes sent to server)
      const fileBytes = await readFile(filePath);
      await runGenerators(record, fileBytes, fileName, title);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add photo");
    } finally {
      setAdding(false);
    }
  };

  const getFileSrc = useFileUrlCache();

  return (
    <PhotoUrlProvider getThumbnailSrc={getFileSrc}>
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
          <button
            onClick={() => { void handleAddClick(); }}
            disabled={adding}
            style={{ ...toolbarButtonStyle, background: "rgba(255,255,255,0.15)" }}
          >
            {adding ? "Adding…" : "Add Photo"}
          </button>
        </div>

        {error && (
          <div
            style={{
              padding: "8px 20px",
              background: "rgba(220,50,50,0.15)",
              color: "#f88",
              fontSize: 13,
              borderBottom: "1px solid rgba(220,50,50,0.3)",
            }}
          >
            {error}
          </div>
        )}

        <PhotoGrid
          images={state.images}
          loading={state.loading}
          hasMore={false}
          onLoadMore={() => {}}
          onSelect={(id) => dispatch({ type: "SET_SELECTED_ID", id })}
        />

        {selectedImage && (
          <PhotoViewer
            image={selectedImage}
            onClose={() => dispatch({ type: "SET_SELECTED_ID", id: null })}
            onUpdateCaption={async () => {}}
            onCrop={async () => {}}
            onShare={async () => null}
          />
        )}
      </div>
    </PhotoUrlProvider>
  );
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

export function App() {
  return (
    <PhotoProvider>
      <PhotosAppDesktopInner />
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
