import React, { useState, useEffect, useRef, useCallback } from "react";
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
  uploadFile,
  getMetadataFileUrl,
  triggerGeneration,
  triggerSyncNow,
  type PhotoRecord,
} from "./src/lib/data-server-client";
import { DataSourceProvider, useDataSource } from "./src/lib/data-source-context";
import { CloudSetupModal } from "./src/lib/CloudSetupModal";
import { downsizeImage } from "./src/lib/image-utils";
import type { DataSourceMode } from "./src/lib/data-client";

function photoRecordToAppImage(record: PhotoRecord): AppImage {
  return {
    id: record.id,
    mimeType: record.mime_type ?? "image/jpeg",
    objectStorageKey: record.object_storage_key ?? "",
    sizeBytes: record.size_bytes ?? 0,
    createdAt: record.created_at ?? new Date().toISOString(),
    updatedAt: record.updated_at ?? new Date().toISOString(),
    width: 0,
    height: 0,
    format: "unknown",
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
    originalFilename: String(record.payload?.fileName ?? record.id),
    googlePhotosId: null,
    sourceImageId: null,
    cropRect: null,
    caption: "",
    title: String(record.payload?.title ?? record.payload?.fileName ?? record.id),
    dateTakenOverride: null,
    thumbnailKey: null,
    thumbnailWidth: 0,
    thumbnailHeight: 0,
    effectiveDateTaken: record.created_at ?? record.updated_at ?? new Date().toISOString(),
  };
}

function useFullSizeUrlCache(mode: DataSourceMode) {
  const [urlMap, setUrlMap] = useState<ReadonlyMap<string, string>>(new Map());
  const loadingRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    setUrlMap(new Map());
    loadingRef.current.clear();
  }, [mode]);

  return useCallback(
    (imageId: string): string => {
      const cached = urlMap.get(imageId);
      if (cached) return cached;
      if (loadingRef.current.has(imageId)) return "";

      loadingRef.current.add(imageId);
      getPhotoFileUrl(imageId, mode)
        .then((url) => {
          loadingRef.current.delete(imageId);
          setUrlMap((prev) => new Map(prev).set(imageId, url));
        })
        .catch(() => {
          loadingRef.current.delete(imageId);
        });

      return "";
    },
    [urlMap, mode],
  );
}

function useFileUrlCache(mode: DataSourceMode) {
  const [urlMap, setUrlMap] = useState<ReadonlyMap<string, string>>(new Map());
  const loadingRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    setUrlMap(new Map());
    loadingRef.current.clear();
  }, [mode]);

  const getFileSrc = useCallback(
    (imageId: string): string => {
      const cached = urlMap.get(imageId);
      if (cached) return cached;
      if (loadingRef.current.has(imageId)) return "";

      loadingRef.current.add(imageId);
      getMetadataFileUrl(imageId, "@starkeep/image:downsize-400", mode)
        .then((thumbnailUrl) => thumbnailUrl ?? getPhotoFileUrl(imageId, mode))
        .then((url) => {
          loadingRef.current.delete(imageId);
          setUrlMap((prev) => new Map(prev).set(imageId, url));
        })
        .catch(() => {
          loadingRef.current.delete(imageId);
        });

      return "";
    },
    [urlMap, mode],
  );

  return getFileSrc;
}

type ThumbnailStrategy = "browser" | "local-sharp" | "remote-sharp";

async function runGenerators(
  record: PhotoRecord,
  file: File,
  fileBytes: Uint8Array,
  fileName: string,
  title: string,
  mode: DataSourceMode,
  thumbnailStrategy: ThumbnailStrategy,
): Promise<void> {
  const targetId = record.id;
  const targetType = "@starkeep/image";

  await postMetadata(targetId, targetType, "@photos/app:provenance", 1, {
    originalFilename: fileName,
    googlePhotosId: null,
    sourceImageId: null,
    cropX: null,
    cropY: null,
    cropWidth: null,
    cropHeight: null,
  }, mode);

  await postMetadata(targetId, targetType, "@photos/app:user-authored", 1, {
    title,
    caption: "",
    dateTakenOverride: null,
  }, mode);

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
      }, mode);
    }
  } catch {
    // EXIF extraction is best-effort
  }

  const generatorId = "@starkeep/image:downsize-400";
  try {
    if (thumbnailStrategy === "browser") {
      // Generate in-browser using Canvas API, upload to whichever endpoint the current
      // mode points at, then kick a sync so the result propagates the other way.
      const result = await downsizeImage(file, 400);
      const fileRef = await uploadFile(result.bytes, result.mimeType, mode);
      await postMetadata(targetId, targetType, generatorId, 1, {
        downsizeWidth: result.width,
        downsizeHeight: result.height,
        downsizeFormat: "webp",
      }, mode, fileRef);
      triggerSyncNow().catch(() => {});

    } else if (thumbnailStrategy === "local-sharp") {
      // Ask the local data-server to run sharp. Generation and storage happen
      // server-side; a push is scheduled automatically after generate.
      await triggerGeneration(record.id, generatorId, "local");

    } else if (thumbnailStrategy === "remote-sharp") {
      // Ask the remote Lambda to run sharp. The result lands in DSQL + S3.
      // A pull cycle brings it to local storage.
      await triggerGeneration(record.id, generatorId, "remote");
      triggerSyncNow().catch(() => {});
    }
  } catch {
    // Thumbnail generation is best-effort
  }
}

const IMAGE_EXTENSIONS: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
  gif: "image/gif", webp: "image/webp", heic: "image/heic",
  heif: "image/heif", avif: "image/avif", tiff: "image/tiff",
};

function PhotosAppInner() {
  const { state, dispatch } = usePhotoContext();
  const { mode, setMode, remoteAvailable } = useDataSource();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCloudSetup, setShowCloudSetup] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [thumbnailStrategy, setThumbnailStrategy] = useState<ThumbnailStrategy>(
    () => (localStorage.getItem("thumbnail-strategy") as ThumbnailStrategy) ?? "browser",
  );
  const isLocalEnv = typeof window !== "undefined" &&
    (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");

  const handleStrategyChange = (s: ThumbnailStrategy) => {
    setThumbnailStrategy(s);
    localStorage.setItem("thumbnail-strategy", s);
  };

  const selectedImage = state.selectedId
    ? state.images.find((img) => img.id === state.selectedId) ?? null
    : null;

  const loadPhotos = useCallback(async () => {
    dispatch({ type: "SET_LOADING", loading: true });
    try {
      const records = await listPhotos(mode);
      dispatch({ type: "SET_IMAGES", images: records.map(photoRecordToAppImage) });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load photos");
    } finally {
      dispatch({ type: "SET_LOADING", loading: false });
    }
  }, [dispatch, mode]);

  useEffect(() => {
    void loadPhotos();
  }, [loadPhotos]);

  const handleFileSelected = async (file: File) => {
    setAdding(true);
    setError(null);
    try {
      const fileName = file.name;
      const title = fileName.replace(/\.[^.]+$/, "");
      const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
      const mimeType = IMAGE_EXTENSIONS[ext] ?? file.type ?? "application/octet-stream";

      const buf = await file.arrayBuffer();
      const fileBytes = new Uint8Array(buf);
      const record = await addPhotoFromPath(fileName, fileBytes, mimeType, fileName, title, mode);
      dispatch({ type: "APPEND_IMAGES", images: [photoRecordToAppImage(record)] });

      runGenerators(record, file, fileBytes, fileName, title, mode, thumbnailStrategy).catch(() => {});
    } catch (err) {
      console.error("[photos] Upload failed:", err);
      setError(err instanceof Error ? err.message : "Failed to add photo");
    } finally {
      setAdding(false);
    }
  };

  const handleAddClick = () => {
    fileInputRef.current?.click();
  };

  const getFileSrc = useFileUrlCache(mode);
  const getFullSizeSrc = useFullSizeUrlCache(mode);

  return (
    <PhotoUrlProvider getThumbnailSrc={getFileSrc} getFullSizeSrc={getFullSizeSrc}>
      <div
        style={{
          minHeight: "100vh",
          background: "#111",
          color: "#fff",
          fontFamily: "sans-serif",
        }}
      >
        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          accept={Object.keys(IMAGE_EXTENSIONS).map((e) => `.${e}`).join(",")}
          style={{ display: "none" }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleFileSelected(file);
            e.target.value = "";
          }}
        />

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

          {/* Local / Remote toggle */}
          <div
            style={{
              display: "flex",
              background: "rgba(255,255,255,0.08)",
              borderRadius: 4,
              border: "1px solid rgba(255,255,255,0.15)",
            }}
          >
            {(["local", "remote"] as DataSourceMode[]).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                disabled={m === "remote" && !remoteAvailable}
                style={{
                  ...toolbarButtonStyle,
                  background: mode === m ? "rgba(255,255,255,0.2)" : "transparent",
                  border: "none",
                  borderRadius: m === "local" ? "3px 0 0 3px" : "0 3px 3px 0",
                  opacity: m === "remote" && !remoteAvailable ? 0.4 : 1,
                  cursor: m === "remote" && !remoteAvailable ? "not-allowed" : "pointer",
                }}
              >
                {m.charAt(0).toUpperCase() + m.slice(1)}
              </button>
            ))}
          </div>

          {/* Thumbnail generation strategy */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12, color: "#aaa" }}>
            <span style={{ whiteSpace: "nowrap" }}>Thumbnail:</span>
            {(
              [
                { value: "browser", label: "Browser" },
                { value: "local-sharp", label: "Local Sharp" },
                { value: "remote-sharp", label: "Remote Sharp" },
              ] as { value: ThumbnailStrategy; label: string }[]
            ).map(({ value, label }) => (
              <label
                key={value}
                style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer", whiteSpace: "nowrap" }}
              >
                <input
                  type="radio"
                  name="thumbnail-strategy"
                  value={value}
                  checked={thumbnailStrategy === value}
                  onChange={() => handleStrategyChange(value)}
                  disabled={(value === "remote-sharp" && !remoteAvailable) || (value === "local-sharp" && !isLocalEnv)}
                  style={{ accentColor: "#888" }}
                />
                {label}
              </label>
            ))}
          </div>

          <button
            onClick={() => setShowCloudSetup(true)}
            title="Cloud setup"
            style={toolbarButtonStyle}
          >
            ⚙
          </button>

          <button
            onClick={handleAddClick}
            disabled={adding}
            style={{ ...toolbarButtonStyle, background: "rgba(255,255,255,0.15)" }}
          >
            {adding
              ? (mode === "remote" ? "Uploading…" : "Adding…")
              : (mode === "remote" ? "Upload Photo" : "Add Photo")}
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

        {showCloudSetup && (
          <CloudSetupModal onClose={() => setShowCloudSetup(false)} />
        )}
      </div>
    </PhotoUrlProvider>
  );
}

export function App() {
  return (
    <DataSourceProvider>
      <PhotoProvider>
        <PhotosAppInner />
      </PhotoProvider>
    </DataSourceProvider>
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
