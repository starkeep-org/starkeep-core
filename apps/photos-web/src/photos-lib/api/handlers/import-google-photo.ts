import type { ApiEndpointDefinition, ApiRequest, ApiContext } from "@starkeep/shared-space-api";
import { sha256Hex } from "../helpers/sha256";
import { createImageRecord } from "../../data/image-record";
import { PROVENANCE_GENERATOR_ID } from "../../metadata/provenance-generator";
import { USER_AUTHORED_GENERATOR_ID } from "../../metadata/user-authored-generator";
import { IMAGE_RECORD_TYPE } from "../../manifest";

interface ImportBody {
  accessToken: string;
  mediaItemId: string;
}

/**
 * Downloads a photo from Google Photos and imports it as a @starkeep/image record.
 * EXIF parsing happens server-side here (unlike regular uploads which parse client-side)
 * because we are downloading the bytes from Google's CDN.
 *
 * After this handler returns { imageId }, the calling layer must invoke
 * sdk.metadata.generateAll() to produce dimensions, EXIF, and thumbnail metadata.
 */
export const importGooglePhotoHandler: ApiEndpointDefinition = {
  namespace: "photos",
  version: "v1",
  path: "photos/google/import",
  method: "POST",
  handler: async (request: ApiRequest, context: ApiContext) => {
    const body = request.body as Partial<ImportBody> | undefined;
    if (!body?.accessToken) return { status: 400, body: { error: "accessToken is required" } };
    if (!body.mediaItemId) return { status: 400, body: { error: "mediaItemId is required" } };

    // Fetch media item metadata from Google Photos API
    const metaResponse = await fetch(
      `https://photoslibrary.googleapis.com/v1/mediaItems/${body.mediaItemId}`,
      { headers: { Authorization: `Bearer ${body.accessToken}` } },
    );

    if (!metaResponse.ok) {
      const text = await metaResponse.text();
      return { status: metaResponse.status, body: { error: `Google API error: ${text}` } };
    }

    const meta = (await metaResponse.json()) as {
      id: string;
      filename: string;
      mimeType: string;
      baseUrl: string;
      mediaMetadata?: { creationTime?: string };
    };

    // Download the full-resolution image bytes
    const downloadResponse = await fetch(`${meta.baseUrl}=d`);
    if (!downloadResponse.ok) {
      return { status: 502, body: { error: "Failed to download image from Google Photos" } };
    }

    const fileBytes = new Uint8Array(await downloadResponse.arrayBuffer());
    const contentHash = await sha256Hex(fileBytes);
    const objectStorageKey = `images/${contentHash.slice(0, 2)}/${contentHash}`;

    await context.objectStorageAdapter.put(objectStorageKey, fileBytes, {
      contentType: meta.mimeType,
    });

    const record = createImageRecord({
      mimeType: meta.mimeType,
      objectStorageKey,
      contentHash,
      sizeBytes: fileBytes.length,
      clock: context.clock,
      ownerId: context.ownerId,
    });

    await context.databaseAdapter.put(record);

    const now = context.clock.now();
    const originalFilename = meta.filename;

    await context.databaseAdapter.upsertSyncableMetadata({
      targetId: record.id,
      targetType: IMAGE_RECORD_TYPE,
      generatorId: PROVENANCE_GENERATOR_ID,
      generatorVersion: 1,
      updatedAt: now,
      inputHash: "",
      value: {
        originalFilename,
        googlePhotosId: meta.id,
        sourceImageId: null,
        cropX: null,
        cropY: null,
        cropWidth: null,
        cropHeight: null,
      },
    });

    await context.databaseAdapter.upsertSyncableMetadata({
      targetId: record.id,
      targetType: IMAGE_RECORD_TYPE,
      generatorId: USER_AUTHORED_GENERATOR_ID,
      generatorVersion: 1,
      updatedAt: now,
      inputHash: "",
      value: {
        caption: "",
        title: originalFilename.replace(/\.[^.]+$/, ""),
        dateTakenOverride: null,
      },
    });

    return { status: 201, body: { imageId: record.id as string } };
  },
};
