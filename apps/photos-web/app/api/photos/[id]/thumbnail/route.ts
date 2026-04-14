import { NextRequest, NextResponse } from "next/server";
import { getSdk } from "../../../../_lib/sdk";
import { PHOTOS_APP_ID } from "@photos/photos-lib";

const SUBJECT = { subjectType: "app", subjectId: PHOTOS_APP_ID } as const;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const sdk = await getSdk();
  const response = await sdk.api.handleRequest({
    path: "photos:v1/photos/thumbnail",
    method: "GET",
    query: { id },
    subject: SUBJECT,
  });

  if (response.status !== 200) {
    return NextResponse.json(response.body, { status: response.status });
  }

  const { thumbnailBase64, contentType } = response.body as {
    thumbnailBase64: string;
    contentType: string;
  };

  const binary = atob(thumbnailBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return new NextResponse(bytes, {
    status: 200,
    headers: { "Content-Type": contentType, "Cache-Control": "public, max-age=86400" },
  });
}
