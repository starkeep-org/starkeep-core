import { NextRequest, NextResponse } from "next/server";

const LOCAL_DATA_SERVER = process.env.STARKEEP_LOCAL_DATA_SERVER_URL ?? "http://127.0.0.1:9820";

/**
 * Proxy the local-data-server's install-step ledger for `appId`. Lets the UI
 * show which step a half-failed install got stuck on without the operator
 * having to inspect sqlite directly.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ appId: string }> },
) {
  const { appId } = await params;

  let resp: Response;
  try {
    resp = await fetch(
      `${LOCAL_DATA_SERVER}/admin/apps/${encodeURIComponent(appId)}/install-steps`,
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
      { error: "install-steps lookup failed", status: resp.status, body: text },
      { status: resp.status },
    );
  }

  const body = await resp.json();
  return NextResponse.json(body);
}
