import { NextResponse } from "next/server";
import { localDataServerUrl } from "../../../src/lib/runtime-config";

/**
 * Proxy for the daemon's `/residency/projection`.
 *
 * A proxy rather than a direct browser fetch because that route is
 * loopback-authorized: it answers to any caller on 127.0.0.1 and to nobody
 * else, which is the gate that makes it safe to serve without an app identity.
 * A browser fetch would come from the page's origin and, in any deployment
 * where admin-web is not on the same host, would simply fail — so going through
 * the server side keeps the loopback assumption true rather than accidentally
 * relying on it.
 */
export async function GET() {
  const base = await localDataServerUrl();
  try {
    const res = await fetch(`${base}/residency/projection`, { cache: "no-store" });
    if (!res.ok) {
      return NextResponse.json(
        { error: `daemon returned ${res.status}` },
        { status: res.status },
      );
    }
    return NextResponse.json(await res.json());
  } catch (err) {
    // A daemon that is not running is the ordinary case on a fresh machine, not
    // an error worth a stack trace — the page renders an offline state from it.
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err), offline: true },
      { status: 503 },
    );
  }
}
