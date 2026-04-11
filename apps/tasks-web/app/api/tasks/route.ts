import { NextRequest, NextResponse } from "next/server";
import { getSdk } from "../../_lib/sdk";

function userId(req: NextRequest): string {
  return req.headers.get("X-User-Id") ?? "anonymous";
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const sdk = await getSdk();
  const groupId = req.nextUrl.searchParams.get("groupId") ?? "";
  const query: Record<string, string> = { groupId };
  for (const [k, v] of req.nextUrl.searchParams) {
    query[k] = v;
  }
  const response = await sdk.api.handleRequest({
    path: "tasks:v1/tasks/ordered",
    method: "GET",
    query,
    subject: { subjectType: "user", subjectId: userId(req) },
  });
  return NextResponse.json(response.body, { status: response.status });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const sdk = await getSdk();
  const body = await req.json();
  const response = await sdk.api.handleRequest({
    path: "tasks:v1/tasks",
    method: "POST",
    body,
    subject: { subjectType: "user", subjectId: userId(req) },
  });
  return NextResponse.json(response.body, { status: response.status });
}
