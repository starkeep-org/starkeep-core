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

  // Resolve access token from stored OAuth tokens if not provided
  if (!query["accessToken"] && sdk.privateStore) {
    const stored = await getStoredAccessToken(sdk);
    if (stored) query["accessToken"] = stored;
  }

  const response = await sdk.api.handleRequest({
    path: "photos:v1/photos/google/list",
    method: "GET",
    query,
    subject: SUBJECT,
  });
  return NextResponse.json(response.body, { status: response.status });
}

async function getStoredAccessToken(sdk: import("@starkeep/sdk").StarkeepSdk): Promise<string | null> {
  if (!sdk.privateStore) return null;
  // Query for the stored tokens record
  const records = await sdk.data.query({ type: "@photos/app:private:google-oauth-tokens" });
  if (records.length === 0) return null;
  const tokens = records[0].content as {
    accessToken?: string;
    expiresAt?: number;
  };
  if (!tokens.accessToken) return null;
  if (tokens.expiresAt && tokens.expiresAt < Date.now() + 60_000) return null; // expire 1 min early
  return tokens.accessToken;
}
