// Runtime config bootstrap for the browser. The admin-web UI talks to the
// local-data-server and the Drive app directly; their URLs are loopback
// defaults on a real single-machine install but ephemeral in a harness-booted
// stack (e2e runs the whole thing on throwaway ports). Server-side this reads
// the same STARKEEP_LOCAL_DATA_SERVER_URL the API routes honor, plus a Drive
// URL, so the browser can pick them up instead of hardcoding loopback ports.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json({
    localDataServerUrl:
      process.env.STARKEEP_LOCAL_DATA_SERVER_URL ?? "http://127.0.0.1:9820",
    driveUrl: process.env.STARKEEP_DRIVE_URL ?? "http://localhost:9830",
  });
}
