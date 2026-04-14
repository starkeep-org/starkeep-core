import { NextRequest, NextResponse } from "next/server";
import { getSdk, generateImageMetadata } from "../../_lib/sdk";
import { PHOTOS_APP_ID } from "@photos/photos-lib";

const SUBJECT = { subjectType: "app", subjectId: PHOTOS_APP_ID } as const;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const sdk = await getSdk();
  const query: Record<string, string> = {};
  for (const [k, v] of req.nextUrl.searchParams) {
    query[k] = v;
  }
  const response = await sdk.api.handleRequest({
    path: "photos:v1/photos/list",
    method: "GET",
    query,
    subject: SUBJECT,
  });
  return NextResponse.json(response.body, { status: response.status });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const sdk = await getSdk();

  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  if (!file) return NextResponse.json({ error: "file is required" }, { status: 400 });

  const originalFilename = (formData.get("originalFilename") as string | null) ?? file.name;
  const title = (formData.get("title") as string | null) || originalFilename.replace(/\.[^.]+$/, "");
  const caption = (formData.get("caption") as string | null) ?? "";

  const fileBytes = new Uint8Array(await file.arrayBuffer());
  const fileBase64 = bytesToBase64(fileBytes);

  const uploadResponse = await sdk.api.handleRequest({
    path: "photos:v1/photos/upload",
    method: "POST",
    body: {
      fileBase64,
      mimeType: file.type || "image/jpeg",
      provenance: { originalFilename },
      userAuthored: { title, caption },
    },
    subject: SUBJECT,
  });

  if (uploadResponse.status !== 201) {
    return NextResponse.json(uploadResponse.body, { status: uploadResponse.status });
  }

  const { imageId } = uploadResponse.body as { imageId: string };

  // Run computed generators (dimensions, EXIF, thumbnail via sharp)
  await generateImageMetadata(imageId);

  // Return the fully assembled AppImage
  const getResponse = await sdk.api.handleRequest({
    path: "photos:v1/photos/item",
    method: "GET",
    query: { id: imageId },
    subject: SUBJECT,
  });

  return NextResponse.json(getResponse.body, { status: getResponse.status });
}
