import { NextRequest, NextResponse } from "next/server";
import { getSdk } from "../../_lib/sdk";

function userId(req: NextRequest): string {
  return req.headers.get("X-User-Id") ?? "anonymous";
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const sdk = await getSdk();
  const response = await sdk.api.handleRequest({
    path: "tasks:v1/groups",
    method: "GET",
    subject: { subjectType: "user", subjectId: userId(req) },
  });
  return NextResponse.json(response.body, { status: response.status });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const sdk = await getSdk();
  const body = await req.json();
  const response = await sdk.api.handleRequest({
    path: "tasks:v1/groups",
    method: "POST",
    body,
    subject: { subjectType: "user", subjectId: userId(req) },
  });
  return NextResponse.json(response.body, { status: response.status });
}
