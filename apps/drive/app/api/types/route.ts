import { listTypes, DriveNotInstalledError } from "../../../src/lib/drive-client";

export async function GET() {
  try {
    const types = await listTypes();
    return Response.json({ types });
  } catch (err) {
    const status = err instanceof DriveNotInstalledError ? 503 : 502;
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status },
    );
  }
}
