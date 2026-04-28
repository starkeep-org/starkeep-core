export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AppImageExif {
  dateTakenRaw: string | null;
  cameraMake: string | null;
  cameraModel: string | null;
  fNumber: number | null;
  exposureTime: string | null;
  iso: number | null;
  lensModel: string | null;
  gpsLat: number | null;
  gpsLon: number | null;
  /** EXIF tag 274 (1–8); used to correct display rotation */
  orientation: number | null;
}

/**
 * App-layer aggregation built by joining a DataRecord with all its metadata rows.
 * NOT a DataRecord subtype — it is an assembled view constructed by API handlers.
 */
export interface AppImage {
  // From DataRecord
  id: string;
  mimeType: string;
  objectStorageKey: string;
  sizeBytes: number;
  createdAt: string; // serialized HLC
  updatedAt: string; // serialized HLC

  // From @starkeep/metadata-core:image-dimensions
  width: number;
  height: number;
  format: string; // "jpeg" | "png" | "unknown"

  // From @photos/app:exif
  exif: AppImageExif;

  // From @photos/app:provenance
  originalFilename: string;
  googlePhotosId: string | null;
  sourceImageId: string | null;
  cropRect: CropRect | null;

  // From @photos/app:user-authored
  caption: string;
  title: string;
  dateTakenOverride: string | null;

  // From @photos/app:thumbnail
  thumbnailKey: string | null;
  thumbnailWidth: number;
  thumbnailHeight: number;

  // Computed: dateTakenOverride ?? exif.dateTakenRaw ?? createdAt
  effectiveDateTaken: string;
}
