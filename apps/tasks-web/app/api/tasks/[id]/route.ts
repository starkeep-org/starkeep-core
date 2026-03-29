import { NextRequest, NextResponse } from "next/server";
import { getSdk } from "../../../_lib/sdk";

function userId(req: NextRequest): string {
  return req.headers.get("X-User-Id") ?? "anonymous";
}

type Params = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { id } = await params;
  const sdk = await getSdk();
  const response = await sdk.api.handleRequest({
    path: "tasks:v1/tasks/item",
    method: "GET",
    query: { id },
    subject: { subjectType: "user", subjectId: userId(req) },
  });
  return NextResponse.json(response.body, { status: response.status });
}

export async function PUT(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { id } = await params;
  const sdk = await getSdk();
  const body = await req.json();
  const response = await sdk.api.handleRequest({
    path: "tasks:v1/tasks/item",
    method: "PUT",
    body,
    query: { id },
    subject: { subjectType: "user", subjectId: userId(req) },
  });
  return NextResponse.json(response.body, { status: response.status });
}

export async function DELETE(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { id } = await params;
  const sdk = await getSdk();
  const response = await sdk.api.handleRequest({
    path: "tasks:v1/tasks/item",
    method: "DELETE",
    query: { id },
    subject: { subjectType: "user", subjectId: userId(req) },
  });
  return NextResponse.json(response.body, { status: response.status });
}
