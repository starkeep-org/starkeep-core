import { driveUrlFromEnv, localDataServerUrlFromEnv } from "../lib/local-daemon-urls";

// Runtime config bootstrap for the browser. The admin-web UI talks to the
// local-data-server and the Drive app directly; their URLs are loopback
// defaults on a real single-machine install but ephemeral in a harness-booted
// stack (e2e runs the whole thing on throwaway ports), and on other ports for a
// second instance on the same machine. The handler serves the addresses the API
// routes themselves use (`lib/local-daemon-urls.ts`), so the browser and the
// server side of admin-web reach the same daemons.
//
// Read per request rather than captured at load, which is what the framework's
// `dynamic = "force-dynamic"` used to buy — a plain Node server has no build
// step to bake them into, so the property now holds by construction.
export function GET(): Response {
  return Response.json({
    localDataServerUrl: localDataServerUrlFromEnv(),
    driveUrl: driveUrlFromEnv(),
  });
}
