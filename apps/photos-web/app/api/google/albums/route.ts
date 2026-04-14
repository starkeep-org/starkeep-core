import { NextRequest, NextResponse } from "next/server";
import { getSdk } from "../../../_lib/sdk";
import { PHOTOS_APP_ID } from "@photos/photos-lib";

const SUBJECT = { subjectType: "app", subjectId: PHOTOS_APP_ID } as const;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const sdk = await getSdk();
  const query: Record<string, string> = {};
  for (const [k, v] of req.nextUrl.searchParams) {
    query[k] = v;
  }

  const response = await sdk.api.handleRequest({
    path: "photos:v1/photos/google/albums",
    method: "GET",
    query,
    subject: SUBJECT,
  });
  return NextResponse.json(response.body, { status: response.status });
}
