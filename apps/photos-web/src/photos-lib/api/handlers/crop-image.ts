import type { ApiEndpointDefinition, ApiRequest, ApiContext } from "@starkeep/shared-space-api";
import type { StarkeepId } from "@starkeep/core";
import { sha256Hex } from "../helpers/sha256";
import { createImageRecord } from "../../data/image-record";
import { PROVENANCE_GENERATOR_ID } from "../../metadata/provenance-generator";
import { USER_AUTHORED_GENERATOR_ID } from "../../metadata/user-authored-generator";
import { IMAGE_RECORD_TYPE } from "../../manifest";
import { assembleAppImage } from "../helpers/assemble-app-image";
import { USER_AUTHORED_GENERATOR_ID as _ua } from "../../metadata/user-authored-generator";

interface CropBody {
  sourceImageId: string;
  cropRect: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

/**
 * Crops an image server-side and stores the result as a new @starkeep/image record.
 * The new record's provenance metadata links back to the source image.
 *
 * Cropping is performed by a `cropImageBytes` function injected via the body
 * to allow different implementations (sharp in Node.js, Canvas in browser).
 * The calling route handler must set `request.body.cropImageBytes` before
 * forwarding to this handler.
 *
 * After this handler returns { imageId }, the calling layer must invoke
 * sdk.metadata.generateAll() to produce dimensions, EXIF, and thumbnail metadata.
 */
export const cropImageHandler: ApiEndpointDefinition = {
  namespace: "photos",
  version: "v1",
  path: "photos/crop",
  method: "POST",
  handler: async (request: ApiRequest, context: ApiContext) => {
    const body = request.body as (Partial<CropBody> & {
      cropImageBytes?: (
        src: Uint8Array,
        x: number, y: number, w: number, h: number,
      ) => Promise<Uint8Array>;
    }) | undefined;

    if (!body?.sourceImageId) return { status: 400, body: { error: "sourceImageId is required" } };
    if (!body.cropRect) return { status: 400, body: { error: "cropRect is required" } };
    if (!body.cropImageBytes) return { status: 400, body: { error: "cropImageBytes function is required" } };

    const { x, y, width, height } = body.cropRect;
    if (width <= 0 || height <= 0) {
      return { status: 400, body: { error: "cropRect width and height must be positive" } };
    }

    const sourceRecord = await context.databaseAdapter.get(body.sourceImageId as StarkeepId);
    if (!sourceRecord?.objectStorageKey) {
      return { status: 404, body: { error: "Source image not found" } };
    }

    const storageResult = await context.objectStorageAdapter.get(sourceRecord.objectStorageKey);
    if (!storageResult) {
      return { status: 404, body: { error: "Source image file not found" } };
    }

    const srcBytes =
      storageResult.data instanceof Uint8Array
        ? storageResult.data
        : new Uint8Array(storageResult.data as ArrayBuffer);

    const croppedBytes = await body.cropImageBytes(srcBytes, x, y, width, height);
    const contentHash = await sha256Hex(croppedBytes);
    const objectStorageKey = `images/${contentHash.slice(0, 2)}/${contentHash}`;

    await context.objectStorageAdapter.put(objectStorageKey, croppedBytes, {
      contentType: "image/jpeg",
    });

    const newRecord = createImageRecord({
      mimeType: "image/jpeg",
      objectStorageKey,
      contentHash,
      sizeBytes: croppedBytes.length,
      clock: context.clock,
      ownerId: context.ownerId,
    });

    await context.databaseAdapter.put(newRecord);

    // Look up source image's provenance to get the original filename
    const sourceProvMeta = await context.databaseAdapter.queryMetadata(IMAGE_RECORD_TYPE, {
      targetId: sourceRecord.id,
      generatorId: PROVENANCE_GENERATOR_ID,
    });
    const sourceProvValue = (sourceProvMeta.entries[0]?.value ?? {}) as {
      originalFilename?: string;
    };
    const sourceFilename = sourceProvValue.originalFilename ?? "image";

    // Look up source image's user-authored metadata to derive title
    const sourceAuthoredMeta = await context.databaseAdapter.queryMetadata(IMAGE_RECORD_TYPE, {
      targetId: sourceRecord.id,
      generatorId: USER_AUTHORED_GENERATOR_ID,
    });
    const sourceAuthoredValue = (sourceAuthoredMeta.entries[0]?.value ?? {}) as {
      title?: string;
    };
    const sourceTitle = sourceAuthoredValue.title ?? sourceFilename.replace(/\.[^.]+$/, "");

    const now = context.clock.now();

    await context.databaseAdapter.upsertSyncableMetadata({
      targetId: newRecord.id,
      targetType: IMAGE_RECORD_TYPE,
      generatorId: PROVENANCE_GENERATOR_ID,
      generatorVersion: 1,
      updatedAt: now,
      inputHash: "",
      value: {
        originalFilename: `crop_of_${sourceFilename}`,
        googlePhotosId: null,
        sourceImageId: body.sourceImageId,
        cropX: x,
        cropY: y,
        cropWidth: width,
        cropHeight: height,
      },
    });

    await context.databaseAdapter.upsertSyncableMetadata({
      targetId: newRecord.id,
      targetType: IMAGE_RECORD_TYPE,
      generatorId: USER_AUTHORED_GENERATOR_ID,
      generatorVersion: 1,
      updatedAt: now,
      inputHash: "",
      value: {
        caption: "",
        title: `Crop of ${sourceTitle}`,
        dateTakenOverride: null,
      },
    });

    return { status: 201, body: { imageId: newRecord.id as string } };
  },
};
