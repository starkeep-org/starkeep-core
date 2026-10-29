/**
 * Whether either of the wizard's two deploy passes is running.
 *
 * A deploy outlives the page that started it: admin-web restarts during the
 * cloud data server pass in development, and the browser reloads with it. The
 * wizard asks here on load, and follows a running pass instead of showing a
 * Redeploy button that would start a second deploy behind the first.
 *
 * Response: { cloudDataServer: "none" | "running" | "ended", drive: same }
 */

import { runStatus } from "../lib/detached-run";

export function GET() {
  return Response.json({
    cloudDataServer: runStatus("cloud-data-server").state,
    drive: runStatus("drive").state,
  });
}
