import { NextRequest, NextResponse } from "next/server";
import { getSdk } from "../../../_lib/sdk";
import { PHOTOS_APP_ID } from "@photos/photos-lib";

const SUBJECT = { subjectType: "app", subjectId: PHOTOS_APP_ID } as const;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const sdk = await getSdk();
  const response = await sdk.api.handleRequest({
    path: "photos:v1/photos/item",
    method: "GET",
    query: { id },
    subject: SUBJECT,
  });
  return NextResponse.json(response.body, { status: response.status });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const sdk = await getSdk();
  const body = await req.json();
  const response = await sdk.api.handleRequest({
    path: "photos:v1/photos/item",
    method: "PATCH",
    body: { ...body, id },
    subject: SUBJECT,
  });
  return NextResponse.json(response.body, { status: response.status });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const sdk = await getSdk();
  const response = await sdk.api.handleRequest({
    path: "photos:v1/photos/item",
    method: "DELETE",
    query: { id },
    subject: SUBJECT,
  });
  return NextResponse.json(response.body, { status: response.status });
}
