/**
 * Canvas-based image utilities used by the photos app.
 *
 * The in-process SDK (TauriDbAdapter, TauriFsObjectStorageAdapter) has been
 * removed. All data operations now go through the data-server HTTP API via
 * data-server-client.ts. The SDK ran its own isolated SQLite DB inside the
 * Tauri sandbox; routing through the data-server makes photos visible to the
 * file-provider and all other Starkeep apps.
 */

import type { CropRect } from "@photos/photos-lib";

/** Crop image bytes using the Canvas API (no sharp in the Tauri webview). */
export async function cropImageBytesCanvas(
  imageBytes: Uint8Array,
  x: number,
  y: number,
  width: number,
  height: number,
): Promise<Uint8Array> {
  const blob = new Blob([imageBytes.buffer as ArrayBuffer]);
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

// Suppress the unused-import warning for CropRect — kept for when crop is re-added.
export type { CropRect };
