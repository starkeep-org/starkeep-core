import { type NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";

export const runtime = "nodejs";

const DATA_SERVER = "http://127.0.0.1:9820";

export async function POST(req: NextRequest) {
  const { targetId, generatorId } = await req.json() as { targetId?: string; generatorId?: string };

  if (!targetId || !generatorId) {
    return NextResponse.json({ error: "targetId and generatorId are required" }, { status: 400 });
  }

  const downsizeMatch = generatorId.match(/^@starkeep\/image:downsize-(\d+)$/);
  if (!downsizeMatch) {
    return NextResponse.json({ error: `Unsupported generatorId: ${generatorId}` }, { status: 400 });
  }
  const maxDimension = parseInt(downsizeMatch[1]!, 10);

  const fileUrlRes = await fetch(`${DATA_SERVER}/data/records/${targetId}/file-url`);
  if (!fileUrlRes.ok) {
    return NextResponse.json({ error: "Could not resolve source file URL" }, { status: fileUrlRes.status === 404 ? 404 : 502 });
  }
  const { url: sourceUrl } = await fileUrlRes.json() as { url: string };

  const sourceRes = await fetch(sourceUrl);
  if (!sourceRes.ok) {
    return NextResponse.json({ error: "Could not fetch source image" }, { status: 502 });
  }
  const inputBuffer = Buffer.from(await sourceRes.arrayBuffer());

  const { default: sharp } = await import("sharp") as { default: typeof import("sharp") };
  const meta = await sharp(inputBuffer).metadata();
  const hasAlpha = meta.hasAlpha ?? false;

  const resized = await sharp(inputBuffer)
    .rotate()
    .resize(maxDimension, maxDimension, { fit: "inside", kernel: "cubic", withoutEnlargement: true })
    [hasAlpha ? "webp" : "jpeg"](hasAlpha ? { quality: 76 } : { quality: 85 })
    .toBuffer();

  const outputMeta = await sharp(resized).metadata();
  const format = hasAlpha ? "webp" : "jpeg";
  const mimeType = hasAlpha ? "image/webp" : "image/jpeg";
  const hash = createHash("sha256").update(new Uint8Array(resized)).digest("hex");

  const uploadRes = await fetch(`${DATA_SERVER}/data/files`, {
    method: "POST",
    headers: { "Content-Type": mimeType },
    body: new Uint8Array(resized),
  });
  if (!uploadRes.ok) {
    return NextResponse.json({ error: "Failed to upload thumbnail to data-server" }, { status: 502 });
  }
  const fileRef = await uploadRes.json() as { key: string; contentHash: string; mimeType: string; sizeBytes: number };

  const metaRes = await fetch(`${DATA_SERVER}/data/metadata`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      targetId,
      targetType: "@starkeep/image",
      generatorId,
      generatorVersion: 1,
      value: {
        downsizeWidth: outputMeta.width ?? 0,
        downsizeHeight: outputMeta.height ?? 0,
        downsizeFormat: format,
      },
      objectStorageKey: fileRef.key,
      contentHash: fileRef.contentHash ?? hash,
      mimeType: fileRef.mimeType,
      sizeBytes: fileRef.sizeBytes,
    }),
  });
  if (!metaRes.ok) {
    return NextResponse.json({ error: "Failed to store metadata" }, { status: 502 });
  }

  // Trigger sync push (fire-and-forget — failure is non-fatal)
  fetch(`${DATA_SERVER}/sync/now`, { method: "POST" }).catch(() => {});

  return NextResponse.json({ ok: true });
}
