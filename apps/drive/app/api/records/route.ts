import { NextRequest } from "next/server";
import { listRecords, DriveNotInstalledError } from "../../../src/lib/drive-client";

export async function GET(req: NextRequest) {
  const type = req.nextUrl.searchParams.get("type") ?? undefined;
  try {
    const records = await listRecords(type);
    return Response.json({ records });
  } catch (err) {
    const status = err instanceof DriveNotInstalledError ? 503 : 502;
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status },
    );
  }
}
