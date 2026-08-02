import { NextRequest, NextResponse } from "next/server";
import { localDataServerUrl } from "../../../../src/lib/runtime-config";

/** Proxy for the daemon's dry-run projection — see ../route.ts for why. */
export async function POST(req: NextRequest) {
  const base = await localDataServerUrl();
  const body = await req.text();
  try {
    const res = await fetch(`${base}/residency/projection`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      cache: "no-store",
    });
    return NextResponse.json(await res.json(), { status: res.status });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err), offline: true },
      { status: 503 },
    );
  }
}

/**
 * Save a policy.
 *
 * The daemon restarts to pick it up, so the response is expected to arrive just
 * before the connection drops. A dropped connection *after* a 200 is the normal
 * case here, not a failure — which is why the client waits for the daemon to
 * come back rather than treating the next failed poll as an error.
 */
export async function PUT(req: NextRequest) {
  const base = await localDataServerUrl();
  const body = await req.text();
  try {
    const res = await fetch(`${base}/residency/policy`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body,
      cache: "no-store",
    });
    return NextResponse.json(await res.json(), { status: res.status });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err), offline: true },
      { status: 503 },
    );
  }
}
