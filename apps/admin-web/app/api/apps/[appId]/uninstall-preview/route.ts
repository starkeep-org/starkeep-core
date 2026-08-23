import { NextRequest, NextResponse } from "next/server";

const LOCAL_DATA_SERVER = process.env.STARKEEP_LOCAL_DATA_SERVER_URL ?? "http://127.0.0.1:9820";

/**
 * Proxy the local-data-server's account of what uninstalling `appId` would
 * destroy. The uninstall confirmation reads this so it can name the app's own
 * syncable tables, their live row counts, and a few real values, rather than
 * asking the operator to approve an unspecified amount of deletion.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ appId: string }> },
) {
  const { appId } = await params;

  let resp: Response;
  try {
    resp = await fetch(
      `${LOCAL_DATA_SERVER}/admin/apps/${encodeURIComponent(appId)}/uninstall-preview`,
    );
  } catch (err) {
    return NextResponse.json(
      {
        error: "Could not reach local-data-server",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 502 },
    );
  }

  if (!resp.ok) {
    const text = await resp.text();
    return NextResponse.json(
      { error: "uninstall-preview lookup failed", status: resp.status, body: text },
      { status: resp.status },
    );
  }

  return NextResponse.json(await resp.json());
}
