import { NextRequest, NextResponse } from "next/server";
import { getSdk } from "../../../_lib/sdk";
import { PHOTOS_APP_ID } from "@photos/photos-lib";

// This endpoint is unauthenticated — the token carries the authorization.
const SUBJECT = { subjectType: "app", subjectId: PHOTOS_APP_ID } as const;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
): Promise<NextResponse> {
  const { token } = await params;
  const sdk = await getSdk();
  const response = await sdk.api.handleRequest({
    path: "photos:v1/photos/shared",
    method: "GET",
    query: { token },
    subject: SUBJECT,
  });
  return NextResponse.json(response.body, { status: response.status });
}
