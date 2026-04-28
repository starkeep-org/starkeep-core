import type { GeneratingFunctionDefinition } from "@starkeep/metadata-engine";
import { IMAGE_RECORD_TYPE } from "../manifest";

export const EXIF_GENERATOR_ID = "@photos/app:exif";

/**
 * Parses EXIF metadata from the raw image bytes.
 * Non-syncable: deterministic output for any given image file.
 */
export const exifGenerator: GeneratingFunctionDefinition = {
  generatorId: EXIF_GENERATOR_ID,
  generatorVersion: 1,
  inputTypes: [IMAGE_RECORD_TYPE],
  dependsOn: [],
  outputColumns: [
    { name: "date_taken_raw", columnType: "text" },
    { name: "camera_make", columnType: "text" },
    { name: "camera_model", columnType: "text" },
    { name: "f_number", columnType: "real" },
    { name: "exposure_time", columnType: "text" },
    { name: "iso", columnType: "integer" },
    { name: "lens_model", columnType: "text" },
    { name: "gps_lat", columnType: "real" },
    { name: "gps_lon", columnType: "real" },
    { name: "orientation", columnType: "integer" },
  ],

  async generate(input, context) {
    const record = await context.databaseAdapter.get(input.dataRecordId);
    if (!record?.objectStorageKey) {
      return { value: emptyExif() };
    }

    const storageResult = await context.objectStorageAdapter.get(record.objectStorageKey);
    if (!storageResult) {
      return { value: emptyExif() };
    }

    try {
      const { default: Exifr } = await import("exifr");
      const exif = await Exifr.parse(storageResult.data instanceof Uint8Array
        ? storageResult.data
        : new Uint8Array(storageResult.data as ArrayBuffer), {
        pick: [
          "DateTimeOriginal",
          "Make",
          "Model",
          "FNumber",
          "ExposureTime",
          "ISO",
          "LensModel",
          "GPSLatitude",
          "GPSLongitude",
          "Orientation",
        ],
        translateValues: false,
      });

      if (!exif) return { value: emptyExif() };

      const dateTakenRaw = exif.DateTimeOriginal
        ? parseExifDate(exif.DateTimeOriginal as string | Date)
        : null;

      const exposureTime = exif.ExposureTime != null
        ? formatExposureTime(exif.ExposureTime as number)
        : null;

      return {
        value: {
          dateTakenRaw,
          cameraMake: (exif.Make as string | null) ?? null,
          cameraModel: (exif.Model as string | null) ?? null,
          fNumber: (exif.FNumber as number | null) ?? null,
          exposureTime,
          iso: (exif.ISO as number | null) ?? null,
          lensModel: (exif.LensModel as string | null) ?? null,
          gpsLat: (exif.GPSLatitude as number | null) ?? null,
          gpsLon: (exif.GPSLongitude as number | null) ?? null,
          orientation: (exif.Orientation as number | null) ?? null,
        },
      };
    } catch {
      return { value: emptyExif() };
    }
  },
};

function emptyExif(): Record<string, unknown> {
  return {
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
  };
}

function parseExifDate(value: string | Date): string | null {
  if (value instanceof Date) return value.toISOString();
  // EXIF format: "YYYY:MM:DD HH:MM:SS"
  const match = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}`;
}

function formatExposureTime(seconds: number): string {
  if (seconds >= 1) return `${seconds}s`;
  const reciprocal = Math.round(1 / seconds);
  return `1/${reciprocal}s`;
}
