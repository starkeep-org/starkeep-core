import { createStarkeepSdk } from "@starkeep/sdk";
import type { StarkeepSdk } from "@starkeep/sdk";
import {
  exifGenerator,
  provenanceGenerator,
  userAuthoredGenerator,
  createThumbnailGenerator,
  registerPhotosEndpoints,
  bootstrapPhotosAppPolicies,
  PHOTOS_APP_ID,
  THUMBNAIL_MAX_WIDTH,
} from "@photos/photos-lib";
import type { ResizeFunction, ResizeResult } from "@photos/photos-lib";
import { TauriDbAdapter } from "./tauri-db-adapter.js";
import { TauriFsObjectStorageAdapter } from "./tauri-fs-adapter.js";

// ---------------------------------------------------------------------------
// Canvas-based resize — works in the Tauri webview without Node.js/sharp
// ---------------------------------------------------------------------------

function createCanvasResizeFn(): ResizeFunction {
  return async (imageBytes: Uint8Array, maxWidth: number): Promise<ResizeResult> => {
    const blob = new Blob([imageBytes]);
    const url = URL.createObjectURL(blob);

    return new Promise<ResizeResult>((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);

        const scale = img.naturalWidth > maxWidth ? maxWidth / img.naturalWidth : 1;
        const w = Math.round(img.naturalWidth * scale);
        const h = Math.round(img.naturalHeight * scale);

        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) { reject(new Error("Could not get 2D context")); return; }
        ctx.drawImage(img, 0, 0, w, h);

        canvas.toBlob(
          (thumbnailBlob) => {
            if (!thumbnailBlob) { reject(new Error("Canvas toBlob failed")); return; }
            thumbnailBlob.arrayBuffer().then((ab) => {
              resolve({ data: new Uint8Array(ab), width: w, height: h, mimeType: "image/jpeg" });
            }).catch(reject);
          },
          "image/jpeg",
          0.85,
        );
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("Failed to load image for thumbnail generation"));
      };
      img.src = url;
    });
  };
}

// ---------------------------------------------------------------------------
// SDK singleton
// ---------------------------------------------------------------------------

let _sdk: StarkeepSdk | null = null;

export async function getSdk(options: {
  ownerId: string;
  nodeId: string;
}): Promise<StarkeepSdk> {
  if (_sdk) return _sdk;

  const thumbnailGenerator = createThumbnailGenerator(createCanvasResizeFn());

  const sharedAdapterOptions = {
    databaseAdapter: new TauriDbAdapter(),
    objectStorageAdapter: new TauriFsObjectStorageAdapter(),
    ownerId: options.ownerId,
    nodeId: options.nodeId,
  };

  // Bootstrap access policies with an owner-level SDK first.
  const ownerSdk = await createStarkeepSdk({
    ...sharedAdapterOptions,
    generators: [],
  });
  await bootstrapPhotosAppPolicies(ownerSdk);
  await ownerSdk.close();

  // Re-initialize as the photos app subject.
  _sdk = await createStarkeepSdk({
    ...sharedAdapterOptions,
    generators: [exifGenerator, provenanceGenerator, userAuthoredGenerator, thumbnailGenerator],
    subject: { subjectType: "app", subjectId: PHOTOS_APP_ID },
  });

  registerPhotosEndpoints(_sdk.api.router);

  return _sdk;
}

export function resetSdk(): void {
  _sdk = null;
}

// ---------------------------------------------------------------------------
// Helpers for calling the SDK API from React components
// ---------------------------------------------------------------------------

export async function apiRequest<T>(
  sdk: StarkeepSdk,
  path: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  userId: string,
  options?: { query?: Record<string, string>; body?: unknown },
): Promise<T> {
  const response = await sdk.api.handleRequest({
    path,
    method,
    query: options?.query,
    body: options?.body,
    subject: { subjectType: "user", subjectId: userId },
  });
  if (response.status >= 400) {
    throw new Error(`API ${method} ${path} → ${response.status}: ${JSON.stringify(response.body)}`);
  }
  return response.body as T;
}

// After upload/crop, run the computed (non-syncable) generators for the image.
export async function generateImageMetadata(sdk: StarkeepSdk, imageId: string): Promise<void> {
  await sdk.metadata.generateAll(imageId);
}

// Crop bytes using Canvas API (no sharp in Tauri webview).
export async function cropImageBytesCanvas(
  imageBytes: Uint8Array,
  x: number,
  y: number,
  width: number,
  height: number,
): Promise<Uint8Array> {
  const blob = new Blob([imageBytes]);
  const url = URL.createObjectURL(blob);

  return new Promise<Uint8Array>((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) { reject(new Error("Could not get 2D context")); return; }
      ctx.drawImage(img, x, y, width, height, 0, 0, width, height);
      canvas.toBlob(
        (cropped) => {
          if (!cropped) { reject(new Error("Canvas toBlob failed")); return; }
          cropped.arrayBuffer().then((ab) => resolve(new Uint8Array(ab))).catch(reject);
        },
        "image/jpeg",
        0.92,
      );
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Image load failed")); };
    img.src = url;
  });
}
