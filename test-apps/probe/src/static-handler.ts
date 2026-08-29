/**
 * The `static` handler: everything a browser reaches — the shell, the sign-in
 * page, the immutable asset, the session routes and the signing proxy.
 *
 * Declared `auth: "session"` in the manifest, so the gateway's session
 * authorizer gates every path except the ones the manifest lists as public.
 */

import { handleRequest } from "./app.js";
import { toRequest, toResult, type ApiGatewayV2Event, type ApiGatewayV2Result } from "./lambda.js";
import { APP_ID } from "./app.js";

const MOUNT = `/apps/${APP_ID}`;

export async function handler(event: ApiGatewayV2Event): Promise<ApiGatewayV2Result> {
  const req = toRequest(event);
  // The Lambda sees the platform-mounted path; the app reasons in its own
  // terms. `/apps/probe` and `/apps/probe/` are both the app root — API
  // Gateway cannot register a route key with an empty trailing segment, so the
  // bare prefix is the only spelling the platform can make public.
  const raw = event.rawPath ?? "/";
  const path = raw.startsWith(MOUNT) ? raw.slice(MOUNT.length) || "/" : raw;
  try {
    return await toResult(await handleRequest(req, path));
  } catch (err) {
    // Answered rather than thrown: a thrown Lambda error becomes a bare 502
    // with nothing in the response to say what failed, and this fixture exists
    // to make platform failures legible.
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: `probe static handler: ${String(err)}` }),
    };
  }
}
