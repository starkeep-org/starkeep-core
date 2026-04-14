import { NextRequest, NextResponse } from "next/server";
import { getSdk, generateImageMetadata } from "../../../_lib/sdk";
import { PHOTOS_APP_ID } from "@photos/photos-lib";

const SUBJECT = { subjectType: "app", subjectId: PHOTOS_APP_ID } as const;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const sdk = await getSdk();
  const body = await req.json();

  const response = await sdk.api.handleRequest({
    path: "photos:v1/photos/google/import",
    method: "POST",
    body,
    subject: SUBJECT,
  });

  if (response.status !== 201) {
    return NextResponse.json(response.body, { status: response.status });
  }

  const { imageId } = response.body as { imageId: string };
  await generateImageMetadata(imageId);

  return NextResponse.json({ imageId }, { status: 201 });
}
