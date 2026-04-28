import type { AppImage } from "@/photos-lib";
import type { PhotoRecord } from "./data-server-client";

export function photoRecordToAppImage(record: PhotoRecord): AppImage {
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
    cropRect: (record.payload?.cropRect as AppImage["cropRect"]) ?? null,
    caption: String(record.payload?.caption ?? ""),
    title: String(record.payload?.title ?? record.payload?.fileName ?? record.id),
    dateTakenOverride: (record.payload?.dateTakenOverride as string | null) ?? null,
    thumbnailKey: null,
    thumbnailWidth: 0,
    thumbnailHeight: 0,
    effectiveDateTaken: record.created_at ?? record.updated_at ?? new Date().toISOString(),
  };
}
