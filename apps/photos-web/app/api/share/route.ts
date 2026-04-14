import { NextRequest, NextResponse } from "next/server";
import { getSdk } from "../../_lib/sdk";
import { PHOTOS_APP_ID } from "@photos/photos-lib";

const SUBJECT = { subjectType: "app", subjectId: PHOTOS_APP_ID } as const;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const sdk = await getSdk();
  const body = await req.json();
  const response = await sdk.api.handleRequest({
    path: "photos:v1/photos/share",
    method: "POST",
    body,
    subject: SUBJECT,
  });
  return NextResponse.json(response.body, { status: response.status });
}
