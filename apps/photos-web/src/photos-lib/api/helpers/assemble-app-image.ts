import { serializeHLC, type DataRecord, type StarkeepId } from "@starkeep/core";
import type { DatabaseAdapter } from "@starkeep/storage-adapter";
import type { MetadataRecord } from "@starkeep/core";
import type { AppImage } from "../../types/app-image";
import { IMAGE_RECORD_TYPE } from "../../manifest";
import { EXIF_GENERATOR_ID } from "../../metadata/exif-generator";
import { PROVENANCE_GENERATOR_ID } from "../../metadata/provenance-generator";
import { USER_AUTHORED_GENERATOR_ID } from "../../metadata/user-authored-generator";
import { THUMBNAIL_GENERATOR_ID } from "../../metadata/thumbnail-generator";

const DIMENSIONS_GENERATOR_ID = "@starkeep/metadata-core:image-dimensions";

function assembleFromEntries(record: DataRecord, entries: MetadataRecord[]): AppImage {
  const find = (gid: string) => entries.find((e) => e.generatorId === gid)?.value ?? {};

  const dims = find(DIMENSIONS_GENERATOR_ID) as {
    width?: number;
    height?: number;
    format?: string;
  };
  const exif = find(EXIF_GENERATOR_ID) as {
    dateTakenRaw?: string | null;
    cameraMake?: string | null;
    cameraModel?: string | null;
    fNumber?: number | null;
    exposureTime?: string | null;
    iso?: number | null;
    lensModel?: string | null;
    gpsLat?: number | null;
    gpsLon?: number | null;
    orientation?: number | null;
  };
  const prov = find(PROVENANCE_GENERATOR_ID) as {
    originalFilename?: string;
    googlePhotosId?: string | null;
    sourceImageId?: string | null;
    cropX?: number | null;
    cropY?: number | null;
    cropWidth?: number | null;
    cropHeight?: number | null;
  };
  const authored = find(USER_AUTHORED_GENERATOR_ID) as {
    caption?: string;
    title?: string;
    dateTakenOverride?: string | null;
  };
  const thumb = find(THUMBNAIL_GENERATOR_ID) as {
    thumbnailKey?: string | null;
    thumbnailWidth?: number;
    thumbnailHeight?: number;
  };

  const hasCropRect =
    prov.cropX != null &&
    prov.cropY != null &&
    prov.cropWidth != null &&
    prov.cropHeight != null;

  const createdAt = serializeHLC(record.createdAt);
  const effectiveDateTaken =
    authored.dateTakenOverride ?? exif.dateTakenRaw ?? createdAt;

  return {
    id: record.id,
    mimeType: record.mimeType ?? "image/jpeg",
    objectStorageKey: record.objectStorageKey ?? "",
    sizeBytes: record.sizeBytes ?? 0,
    createdAt,
    updatedAt: serializeHLC(record.updatedAt),
    width: dims.width ?? 0,
    height: dims.height ?? 0,
    format: dims.format ?? "unknown",
    exif: {
      dateTakenRaw: exif.dateTakenRaw ?? null,
      cameraMake: exif.cameraMake ?? null,
      cameraModel: exif.cameraModel ?? null,
      fNumber: exif.fNumber ?? null,
      exposureTime: exif.exposureTime ?? null,
      iso: exif.iso ?? null,
      lensModel: exif.lensModel ?? null,
      gpsLat: exif.gpsLat ?? null,
      gpsLon: exif.gpsLon ?? null,
      orientation: exif.orientation ?? null,
    },
    originalFilename: prov.originalFilename ?? "",
    googlePhotosId: prov.googlePhotosId ?? null,
    sourceImageId: prov.sourceImageId ?? null,
    cropRect: hasCropRect
      ? {
          x: prov.cropX!,
          y: prov.cropY!,
          width: prov.cropWidth!,
          height: prov.cropHeight!,
        }
      : null,
    caption: authored.caption ?? "",
    title: authored.title ?? "",
    dateTakenOverride: authored.dateTakenOverride ?? null,
    thumbnailKey: thumb.thumbnailKey ?? null,
    thumbnailWidth: thumb.thumbnailWidth ?? 0,
    thumbnailHeight: thumb.thumbnailHeight ?? 0,
    effectiveDateTaken,
  };
}

export async function assembleAppImage(
  record: DataRecord,
  db: DatabaseAdapter,
): Promise<AppImage> {
  const metaResult = await db.queryMetadata(IMAGE_RECORD_TYPE, { targetId: record.id });
  return assembleFromEntries(record, metaResult.entries);
}

export async function assembleAppImages(
  records: DataRecord[],
  db: DatabaseAdapter,
): Promise<AppImage[]> {
  if (records.length === 0) return [];

  const ids = records.map((r) => r.id) as StarkeepId[];
  const metaResult = await db.queryMetadata(IMAGE_RECORD_TYPE, { targetIds: ids });

  const metaByTarget = new Map<string, MetadataRecord[]>();
  for (const entry of metaResult.entries) {
    const existing = metaByTarget.get(entry.targetId) ?? [];
    existing.push(entry);
    metaByTarget.set(entry.targetId, existing);
  }

  return records.map((record) =>
    assembleFromEntries(record, metaByTarget.get(record.id) ?? []),
  );
}
