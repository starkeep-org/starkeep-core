import { NextRequest, NextResponse } from "next/server";
import { getSdk, generateImageMetadata } from "../../../_lib/sdk";
import { PHOTOS_APP_ID } from "@photos/photos-lib";
import type { CropRect } from "@photos/photos-lib";

const SUBJECT = { subjectType: "app", subjectId: PHOTOS_APP_ID } as const;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const sdk = await getSdk();
  const { sourceImageId, cropRect }: { sourceImageId: string; cropRect: CropRect } = await req.json();

  const sharp = (await import("sharp")).default;
  const cropImageBytes = async (
    src: Uint8Array,
    x: number,
    y: number,
    w: number,
    h: number,
  ): Promise<Uint8Array> => {
    const buf = await sharp(src)
      .extract({ left: x, top: y, width: w, height: h })
      .jpeg({ quality: 90 })
      .toBuffer();
    return new Uint8Array(buf);
  };

  const response = await sdk.api.handleRequest({
    path: "photos:v1/photos/crop",
    method: "POST",
    body: { sourceImageId, cropRect, cropImageBytes },
    subject: SUBJECT,
  });

  if (response.status !== 201) {
    return NextResponse.json(response.body, { status: response.status });
  }

  const { imageId } = response.body as { imageId: string };
  await generateImageMetadata(imageId);

  const getResponse = await sdk.api.handleRequest({
    path: "photos:v1/photos/item",
    method: "GET",
    query: { id: imageId },
    subject: SUBJECT,
  });

  return NextResponse.json(getResponse.body, { status: getResponse.status });
}
