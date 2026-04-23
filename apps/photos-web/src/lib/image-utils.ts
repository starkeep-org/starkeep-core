export interface DownsizeResult {
  bytes: Uint8Array;
  mimeType: string;
  width: number;
  height: number;
}

export async function downsizeImage(
  file: File | Blob,
  maxDimension: number,
): Promise<DownsizeResult> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const blob = await canvas.convertToBlob({ type: "image/webp", quality: 0.85 });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { bytes, mimeType: "image/webp", width: w, height: h };
}
